import {
  DAMAGE_NUMBER_LIFETIME_MS,
  FALL_MS_PER_HEIGHT,
  NOISE_LIFETIME_MS,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  STRIKE_DURATION_MS,
  WALK_DURATION_MS,
} from "../game/constants";
import {
  inCombat,
  UNKNOWN_REMAINING_MS,
  type StatusInstance,
  walkSpeedPercentFrom,
} from "../game/statuses";
import { combatantOf, type Combatant, mayHarm } from "../game/pvp";
import {
  ageEffects,
  ageFlights,
  beginEffect,
  type FlightEffect,
  flightDurationMs,
  type ProjectileFlight,
} from "../game/projectile";
import { resolveProjectile } from "../lib/projectile";

import {
  MAX_HELD_TRANSITIONS,
  MAX_TRANSITION_MS,
  type HeldTransition,
  type TileTransitionNote,
} from "../lib/tileTransition";
import type { StrikeState } from "../game/strike";
import { actorDirection, actorStillAt, locateActor, type ActorLocation } from "../game/actors";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import {
  canConsumeFrom,
  canTalkFrom,
  canDropAt,
  canEquipFrom,
  canPickUpFrom,
  canPushFrom,
  canRewardFrom,
  canSwitchFrom,
  canAddStatusFrom,
  canSetSpawnFrom,
  canTeleportFrom,
  type ObjectRef,
} from "../game/affordances";
import { canBeginExtract, type Extraction, type ExtractionProgress } from "../game/extract";
import { type Progress, windProgress } from "../game/progress";
import { gravityPullOn } from "../game/gravity";
import { type Equipment, emptyEquipment } from "../game/equipment";
import { type Attributes, attributesOf } from "../game/attributes";
import {
  castability,
  castableSpells,
  type CastContext,
  type CasterPoint,
  type CastPoint,
  type CastProgress,
  type CastSlot,
  type SpellButton,
} from "../game/casting";
import { castRefusalNotice } from "../game/notices";
import { masteriesFromXp, type MasteryXp } from "../lib/mastery";
import { type NaturalSpell, resolveBattler } from "../lib/battler";
import type { StatusDef } from "../lib/status";
import { canMoveItem, itemInSlot, type SlotRef } from "../game/itemMoves";
import type { ConsumeSource } from "../game/itemUse";
import { canTransmuteFrom } from "../game/transmute";
import { resolveConsumable } from "../lib/item";
import { moveEntity, setEntityDirection } from "../game/mapMutations";
import { chooseStep } from "../game/stepping";
import type {
  ActorSnapshot,
  ChatBubble,
  DamageNumber,
  FallState,
  NoiseEmission,
  GameInput,
  GameSnapshot,
  PlaySession,
  WalkState,
} from "../game/GameSession";
import { groundWalkSpeedPercent, standingAbs, walkDurationMsFor } from "../game/movement";
import { STRIKE_RECOVERY_STEPS, strikeRecoveryMs } from "../game/combat";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import {
  absoluteStandingElevation,
  chunkifyMap,
  emptyMap,
  getStack,
  isPlayerBody,
  setStacks,
} from "../lib/mapData";
import type { Coord, Direction, FlatMapFile, MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { CHAT_LIFETIME_MS, MAX_CHAT_LENGTH, MAX_CHATS_PER_CELL } from "./chat";
import { MAX_COMMAND_LENGTH, isCommand } from "../game/commands";
import { SOCKET_OPEN, type ClientSocket } from "./socket";
import {
  parseServerMessage,
  type CellPatch,
  type ClientMessage,
  type CarriedLightsPatch,
  type StatusIdsPatch,
  type PvpPatch,
  type CastingPatch,
  type ExtractionPatch,
  type HpPatch,
  type NamePatch,
  type MotionEvent,
} from "./protocol";

/** A bubble on screen, with the clock that will take it away. */
type LiveChat = ChatBubble & { elapsedMs: number };

/** Motion a client is animating, with its own clock. */
type RemoteMotion = {
  walk: WalkState | null;
  fall: FallState | null;
  slide: {
    object: ObjectRef;
    from: { x: number; y: number; z: number };
    count: number;
    elapsedMs: number;
  } | null;
  strike: StrikeState | null;
  /**
   * Last place this actor was found, so relocating them stays a cell lookup.
   *
   * The cell alone rather than the whole {@link ActorLocation}: this is a hint
   * handed to `locateActor`, which re-reads the stack to confirm it, and the
   * placement it was found in is never read back off here. Narrowed because it
   * is also set from a `spawned` event, where the body's cell is known and the
   * placement in it may not have arrived yet.
   */
  lastSeen: (Coord & { stackIndex: number }) | null;
};

/**
 * A step this client took on its own authority, still waiting to become true.
 *
 * `landed` is about the drawing rather than the server: it turns true when the
 * lerp finishes and the move goes into the predicted board, which is what lets
 * the next step be chosen from the cell this one reached. Until then the actor
 * is still being dragged out of the cell below and the board must still hold
 * them there.
 */
type PredictedStep = {
  seq: number;
  to: Coord;
  direction: Direction;
  landed: boolean;
  /** Time since it was sent, for {@link STEP_CONFIRM_GRACE_MS}. */
  waitedMs: number;
  /**
   * How long this step takes to walk, as this side drew it.
   *
   * Recorded rather than re-derived, because the answer moves: a status wears
   * off and the ground changes underfoot, and what the backstop has to wait for
   * is the walk that was actually *started*. @see STEP_CONFIRM_GRACE_MS
   */
  durationMs: number;
};

/**
 * How far ahead of the server this client will walk before it waits.
 *
 * A step is confirmed a round trip *plus* a walk after it was sent, so several
 * are legitimately outstanding at once on exactly the slow link this prediction
 * exists for — a tight cap here would reinstate the stall it is meant to
 * remove. Eight covers a round trip well past a second. Past that something is
 * wrong rather than slow, and {@link STEP_CONFIRM_GRACE_MS} is what notices.
 */
const MAX_PREDICTED_STEPS = 8;

/**
 * How long the oldest unconfirmed step waits **past its own walk** before this
 * client gives up on it.
 *
 * The backstop, not the mechanism: a refused step normally comes back as its own
 * message and is rolled back at once. This catches only the cases where no
 * answer arrives at all, and sits well past the round trip a confirmation takes
 * so an ordinary slow link never trips it.
 *
 * **On top of the step's own duration, not instead of it**, because what a
 * confirmation waits for is the walk: the patch that commits the move *is* the
 * acknowledgement — see {@link dropConfirmedSteps} — and the server does not
 * send it until the body lands. A flat figure was fine while every step took
 * 200ms and became a bug the moment a status could slow one: a body at the
 * floor of {@link MIN_WALK_SPEED_PERCENT} walks a cell in two seconds, which
 * *is* this figure, so every paralysed step was abandoned at 99% of the way
 * across and snapped back to where it started.
 */
export const STEP_CONFIRM_GRACE_MS = 2_000;

/**
 * The world as this browser sees it.
 *
 * Implements the same interface as the local simulation, so the renderer cannot
 * tell them apart. The difference is only where truth comes from: cells arrive
 * as patches and are authoritative, while motion is interpolated locally from
 * the events that announced it.
 *
 * Your own walking is the exception, and it is the reason this class is not
 * simply a patch applier. Asking the server to decide each step put a round trip
 * between pressing a key and moving, which on a distant object is the difference
 * between a game and a remote control. So this client decides its own steps from
 * the same rule the server validates with, draws them at once, and tells the
 * server afterwards.
 *
 * That leaves two boards. {@link serverMap} is what the server last said, and
 * {@link map} — the one everything else reads — is that board with the steps it
 * has not confirmed yet replayed on top. Every patch rebuilds the second from
 * the first, so a mistaken guess is corrected by the next thing the server says
 * rather than accumulating. Only your own walking is predicted: falls, pushes
 * and switches still cost their round trip, which keeps the guessing to the one
 * thing that is held down for seconds at a time.
 */
export class RemoteSession implements PlaySession {
  /** The board as the server last described it. */
  private serverMap: MapFile = emptyMap();
  /** {@link serverMap} plus {@link pending}. What the renderer draws. */
  private map: MapFile = emptyMap();
  private readonly tilesById: Record<string, TileDef>;
  private selfId = "";
  private serverMinutesOfDay: MinutesOfDay = DEFAULT_PLAY_MINUTES;
  private readonly motions = new Map<string, RemoteMotion>();
  /** Steps drawn but not yet confirmed by the server, oldest first. */
  private pending: PredictedStep[] = [];
  private nextStepSeq = 0;
  /** What the player is holding, so a finished step can chain into the next. */
  private held: GameInput = { directions: [] };
  /** Last facing sent, so a held key does not resend it every frame. */
  private facing: Direction | null = null;
  /**
   * Milliseconds until this body may take a step again, having just swung.
   *
   * The one thing this side has to re-run rather than be told: the simulation
   * refuses a step from a body still recovering, and a client that kept
   * predicting through it would draw a run the server holds a cell at a time.
   * Every step of it is a guess that turns out true a moment later, so nothing
   * is ever corrected on screen — the body simply walks at whatever pace the
   * socket answers, which is the exact latency prediction exists to hide.
   *
   * Held for this body alone. Everybody else's walking arrives as an event that
   * has already been through that refusal. @see `./protocol`'s `swung`
   */
  private attackRecoveryMs = 0;
  /** Where the server last had us, so finding it stays a cell lookup. */
  private serverSeen: ActorLocation | null = null;
  private chats: LiveChat[] = [];
  /** Ticks up per message, so two lines from one actor are two bubbles. */
  private nextChatId = 0;
  /**
   * Noises hanging in the air, with the clock that will take them away.
   *
   * No local id counter, unlike {@link chats}: a noise arrives already carrying
   * one, because the session that made it had to name it for its own live list
   * anyway. One name for one sound on both sides of the wire.
   */
  private noises: NoiseEmission[] = [];
  /**
   * Hit points as the server last reported them, per actor.
   *
   * Kept beside the actors rather than folded into the map, because that is
   * where the server keeps them too: a health bar changing must not rewrite a
   * cell, or every blow would dirty the light and the geometry around it.
   */
  private readonly hps = new Map<string, { hp: number; maxHp: number; rating: number }>();
  /**
   * What each person the server has named is called.
   *
   * **Never cleared except by a `hello`, and never overwritten**, which makes
   * it the one map here that is not a cache of a moving fact. A name is typed
   * at character creation and fixed after that, so the server sends each one
   * once — on arrival, or when the body walks into reach — and the client keeps
   * it. A body that walks out of reach and back is announced again and the
   * second announcement says the same thing.
   *
   * Creatures are absent by design: they are named after their tile, out of the
   * catalogue this client already holds. @see `../game/displayName`
   */
  private readonly names = new Map<string, string>();
  /**
   * The lit things each actor is carrying, as the server last reported them.
   *
   * Beside the actors for the same reason hit points are, and it is the sharper
   * case of the two: a carried light is painted as a dynamic emitter every
   * frame, so putting it on the board would dirty and re-bake the light chunks
   * around anybody walking with a lantern — the exact cost this whole path
   * exists to avoid.
   */
  private readonly carriedLights = new Map<string, string[]>();
  /**
   * Everybody's statuses as instances, rebuilt from the ids the wire broadcasts.
   *
   * Held built rather than as raw ids so the list handed to a snapshot is the
   * same array every frame — the renderer walks it per actor per frame, and
   * rebuilding one per frame would allocate for a list that almost never
   * changes. It is replaced wholesale when a patch says the set has changed.
   *
   * Every instance in here reads {@link UNKNOWN_REMAINING_MS}, because the
   * countdown is not broadcast. @see StatusIdsPatch
   */
  private readonly statusesById = new Map<string, StatusInstance[]>();
  /**
   * Everybody's pull in progress as the broadcast last described it, wound on
   * the render clock between its two messages.
   *
   * The viewer's own is {@link extracting}, which carries the key its row
   * matches against; this is for the bar over every other head.
   * @see ExtractionPatch
   */
  private readonly extractionsById = new Map<string, ExtractionProgress>();
  /**
   * Who is fighting other players, as the broadcast last said. @see `PvpPatch`
   *
   * A set rather than a map of booleans, because off is what a body nobody has
   * mentioned is: the server sends the mark when it goes on and again when it
   * comes off, and everybody else is absent from both.
   *
   * The viewer's own is in here too, on {@link castingsById}' terms: the switch
   * is the server's state and this side predicts none of it, so the button
   * follows the broadcast rather than a copy of its own.
   */
  private readonly pvpOn = new Set<string>();
  /**
   * Everybody's cast in progress as the broadcast last described it, wound on
   * the render clock between its two messages.
   *
   * **The viewer's own is in here too**, which is where this parts company with
   * {@link extractionsById} beside it: a pull has an owner's half carrying the
   * key its interaction row matches against, and a cast has no row and no key.
   * What the viewer's own entry is for is the row of spell buttons, which dims
   * while anything is being cast. @see `../game/casting`'s `CastContext.casting`
   */
  private readonly castingsById = new Map<string, CastProgress>();
  /**
   * What this viewer is carrying, as the server last said.
   *
   * Never predicted, unlike a step. A step is drawn immediately because the
   * client can re-run the rule that allows it and be right almost always; what
   * ends up in a bag depends on what else is in it and on a board the server
   * owns, and a wrong guess would show somebody an item they do not have.
   */
  private equipment: Equipment = emptyEquipment();
  /**
   * How long each of this body's own spells has left, as the server last said.
   *
   * Beside the kit because it arrives with it and is the same kind of thing:
   * what this caster can press right now. Not wound here — the server sends a
   * fresh record every second a spell is cooling, on exactly the terms a
   * stone's cooldown rides the kit. @see `../game/GameSession`'s
   * `ActorRuntime.spellCooldownMs`
   */
  private spellCooldowns: Readonly<Record<string, number>> = {};
  /**
   * Sentences the server has addressed to this player, waiting for a frame.
   *
   * Never seeded and never restored, unlike everything else held here, which is
   * whole state the server repeats. A notice is an event, so a reconnect starts
   * silent rather than replaying whatever was said before the socket dropped.
   * @see ./protocol
   */
  private pendingNotices: string[] = [];
  /**
   * Which rewards this player has already taken, as the server last said.
   *
   * Never predicted either, and for a stronger reason than the kit: a tag is
   * what closes a chest for ever, so a guessed one would take a reward off the
   * screen that the player has not actually been given. Replaced wholesale, so
   * its identity is what tells the renderer to rebuild its rows.
   */
  private tags: readonly string[] = NO_TAGS;
  /**
   * Where this player comes back, as the server last said — see
   * `GameSnapshot.spawnAt`, which is the whole of what it is for.
   *
   * Null until the `hello` fills it in, which reads as "nothing has told us
   * yet" and leaves every respawn point offering a live row. That is the right
   * way round for a fact that arrives a moment late: a grey button that would
   * have worked is a worse lie than a live one that turns out to be a no-op.
   */
  private spawnAt: Coord | null = null;
  /**
   * Where the viewer is in a conversation, as the server last said. Whole
   * state like the kit and the tags beside it; null is the panel closed.
   */
  private conversation: Conversation | null = null;
  /**
   * The pull this player is part-way through, as the server last said — see
   * `../game/extract`'s `extractKey`, which is how the placement is named.
   *
   * Never predicted, on the terms the kit and the tags are not: the pull is the
   * server's clock, and a client that started one of its own would draw a bar
   * for a pull the far end never began. Replaced outright, so its identity is
   * what tells the renderer to rebuild its rows.
   */
  private extracting: Extraction | null = null;
  /**
   * The wait before this viewer's next blow, or null when they are not engaged.
   *
   * Held beside {@link extracting} and wound like it: the wire carries it twice
   * — once when it changes, once when the fight ends — and the countdown in
   * between is this side's. @see windBars
   */
  private nextBlow: Progress | null = null;
  /**
   * What this player has learnt, as the server last said.
   *
   * Never predicted, on the same terms the kit and the tags are not: what a
   * blow was worth depends on a comparison only the server can make, and a
   * client guessing would show a bar creeping on a fight that paid nothing.
   */
  private masteryXp: MasteryXp = {};
  /** Numbers still floating, with their own clocks. */
  private damage: DamageNumber[] = [];
  /**
   * Arrows still in the air, with their own clocks.
   *
   * Beside {@link damage} rather than derived from it, and never from the
   * `hps` patch either: a shot and what it came to are two facts the server
   * sends in one frame and neither can be recovered from the other. A melee
   * blow owes a number and no arrow; a shot that killed floats a number over
   * an empty cell while the arrow finishes its flight.
   */
  private projectiles: ProjectileFlight[] = [];
  /**
   * The effects those flights are playing, aged on the same clock.
   *
   * Never heard, always worked out: nothing on the wire announces one, because
   * the event that announced the shot named a catalogue entry that says what to
   * play, and the moments it plays at are arithmetic both ends agree on.
   * @see `../game/projectile`
   */
  private flightEffects: FlightEffect[] = [];
  /**
   * Tile transitions heard but not yet taken by the renderer, with when.
   *
   * Stamped against a clock that keeps running while the tab is hidden —
   * frames stop, and the socket keeps delivering — so a player coming back to
   * a background tab is handed the few that could still be running, never a
   * backlog. See `../lib/tileTransition`.
   */
  private transitions: Array<{ note: TileTransitionNote; heardAtMs: number }> = [];
  /** Who this client is pointing at; echoed back in the snapshot for the outline. */
  private targetId: string | null = null;
  /**
   * Whether that target is somebody to fight. Held locally for the same reason
   * the target is — the outline changes colour on the frame the mode is flipped,
   * not a round trip later — and sent, because the swinging is the server's.
   *
   * Starts off on a fresh session, which a reconnect is: the page re-applies
   * whatever the player has the button set to once the socket is up.
   */
  private attacking = false;
  /**
   * The last snapshot this client's own body produced.
   *
   * Kept so a death — which takes the body off the board entirely — leaves the
   * camera where it happened instead of snapping to the map origin. See
   * {@link getSnapshot}.
   */
  private lastSelf: ActorSnapshot | null = null;
  private ready = false;
  private onReady: (() => void) | null = null;
  /**
   * Whether this player's body has been taken off the board for good.
   *
   * Told rather than inferred, though the map would appear to say it: a body is
   * missing from the board for a whole second every time somebody walks through
   * a doorway the client has not been patched about yet, and the difference
   * between "not there" and "dead" is the difference between a moment's stale
   * map and a screen the player cannot dismiss.
   *
   * It is also what the silence means. From the death onwards the server sends
   * this socket nothing at all, so the board frozen on screen is not a world
   * that stopped — it is one nobody is telling us about any more.
   */
  private dead = false;
  private onDead: ((dead: boolean) => void) | null = null;
  /** Told when the world says it is restarting. See {@link setOnRestarting}. */
  private onRestarting: (() => void) | null = null;
  /** Told which protocol the server speaks. See {@link setOnOutdated}. */
  private onOutdated: ((serverVersion: number) => void) | null = null;
  /** How many people the server last said were here. */
  private players = 0;
  private onPlayers: ((count: number) => void) | null = null;
  /** Told the hour whenever the server says one. See {@link setOnClockSet}. */
  private onClockSet: ((minutes: MinutesOfDay) => void) | null = null;

  constructor(
    /**
     * Where frames come from and go to — a `WebSocket` online, and a port on
     * the world running in this tab under `/admin/play`. Nothing below can
     * tell, which is the point: one client, one wire, two ways of being
     * connected. @see ./socket
     */
    private readonly socket: ClientSocket,
    tiles: TileDef[],
    /**
     * The status catalogue, for the one thing this side has to work out about
     * somebody else's condition: how fast it makes them walk. Constructor-shaped
     * like the tiles rather than a setter, because a session that had it a
     * moment later would time the first steps it ever drew at the wrong pace.
     * @see walkSpeedPercentOf
     */
    private readonly statusDefs: Record<string, StatusDef> = {},
    /** Milliseconds on a clock that keeps running while the tab is hidden. */
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tilesById = tilesByIdFromList(tiles);
    socket.addEventListener("message", this.onMessage);
  }

  /** Fires once the first `hello` has landed and there is a world to draw. */
  setOnReady(cb: (() => void) | null) {
    this.onReady = cb;
    if (this.ready) cb?.();
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Watch for this player's death, and for their coming back from it.
   *
   * Pushed rather than polled, like the headcount: it changes twice in a
   * session at most, and asking every frame would be a render per frame of a
   * boolean that is almost always false. Fires on registration too, so a
   * listener that arrives after the death still learns about it.
   */
  /**
   * Told when the world announces it is going away for a deploy.
   *
   * Separate from the close that follows, because the two mean different things
   * to the person watching: a socket that simply drops is a problem, and one
   * that was announced is a wait. The page uses it to choose a message and to
   * come back promptly rather than backing off.
   */
  setOnRestarting(cb: (() => void) | null) {
    this.onRestarting = cb;
  }

  /**
   * Told what protocol the far end speaks, when it turns out not to be ours.
   *
   * The close that follows says only *that* the versions differ, and the two
   * ways they can differ want opposite advice: a tab older than the server is
   * fixed by reloading, and a tab *newer* than it is a server that has not
   * caught up, where reloading is an infinite wait. The number is the only thing
   * that separates them, so it is carried out to the page. @see PROTOCOL_VERSION
   */
  setOnOutdated(cb: ((serverVersion: number) => void) | null) {
    this.onOutdated = cb;
  }

  setOnDead(cb: ((dead: boolean) => void) | null) {
    this.onDead = cb;
    cb?.(this.dead);
  }

  isDead(): boolean {
    return this.dead;
  }

  /**
   * Ask for a body again.
   *
   * The one thing this session can do while dead, and it is sent rather than
   * predicted: where somebody comes back in is the server's answer, and the
   * reply is a whole `hello` that resets this client outright. Nothing is
   * cleared here — the `hello` handler does all of it, on the same path a
   * replaced world takes.
   */
  rebirth() {
    if (!this.dead) return;
    this.send({ type: "rebirth" });
  }

  /**
   * Watch the headcount.
   *
   * Pushed rather than polled because it changes on somebody else's timetable
   * and can sit unchanged for hours; asking every frame would be a render of
   * the same number sixty times a second. Fires on registration too, for a
   * listener that arrives after the `hello` it would have learnt from.
   */
  setOnPlayers(cb: ((count: number) => void) | null) {
    this.onPlayers = cb;
    if (this.ready) cb?.(this.players);
  }

  playerCount(): number {
    return this.players;
  }

  /** Note a death or a return, telling anyone watching if it changed. */
  private setDead(dead: boolean) {
    if (dead === this.dead) return;
    this.dead = dead;
    this.onDead?.(dead);
  }

  /** Take a headcount from the wire, telling anyone watching if it moved. */
  private setPlayers(count: number) {
    if (count === this.players) return;
    this.players = count;
    this.onPlayers?.(count);
  }

  /**
   * The world's time of day as of the last `hello` or `clock`.
   *
   * Read when the renderer starts: from there the renderer runs the same rate
   * the server does, so a single anchor is enough to keep two browsers in the
   * same hour without a clock on the wire every tick. A `/time` is the one
   * thing that moves the anchor, and {@link setOnClockSet} is how it is heard.
   */
  minutesOfDay(): MinutesOfDay {
    return this.serverMinutesOfDay;
  }

  /**
   * Watch for the server saying what hour it is.
   *
   * Fires on every `hello` as well as on a `clock`, because both are the
   * server's hour and a renderer that outlives a rebirth or a replaced world
   * would otherwise keep the one it started with.
   */
  setOnClockSet(cb: ((minutes: MinutesOfDay) => void) | null) {
    this.onClockSet = cb;
  }

  private setClock(minutes: MinutesOfDay) {
    this.serverMinutesOfDay = minutes;
    this.onClockSet?.(minutes);
  }

  dispose() {
    this.socket.removeEventListener("message", this.onMessage);
  }

  private onMessage = (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    const message = parseServerMessage(event.data);
    if (!message) return;

    // First, because it is the one message that is about the connection rather
    // than the world: everything below describes a board, and this says the
    // board is about to go away for a moment.
    if (message.type === "serverRestarting") {
      this.onRestarting?.();
      return;
    }

    if (message.type === "keepalive") {
      // Nothing to do. Its arrival is the whole content: it exists so the
      // socket has traffic on it while the world is at rest.
      return;
    }

    if (message.type === "outdated") {
      // The close that follows carries the code the page acts on; this carries
      // the only thing that close cannot, which is which side is behind.
      this.onOutdated?.(message.serverVersion);
      return;
    }

    if (message.type === "clock") {
      this.setClock(message.minutesOfDay);
      return;
    }

    if (message.type === "hello") {
      this.selfId = message.selfId;
      this.setClock(message.minutesOfDay);
      this.serverMap = chunkifyMap(message.map as FlatMapFile);
      this.map = this.serverMap;
      // A restart moves everyone, so nothing that was animating still applies —
      // including every step this client was still holding a guess about.
      this.pending = [];
      // Beside them, because a recovery is a clock on a body the restart has
      // just replaced: the session on the other side is holding none, and one
      // left running here would plant the new body for a step it never earned.
      this.attackRecoveryMs = 0;
      this.facing = null;
      this.serverSeen = null;
      this.lastSelf = null;
      this.motions.clear();
      // And every bubble is pinned to a coordinate in a world that no longer
      // exists, which would leave them hanging over whatever is there now.
      this.chats = [];
      this.damage = [];
      // And every arrow is measured between two cells in a world that no longer
      // exists, on the same terms the bubbles above are — as is every effect
      // one of them is playing.
      this.projectiles = [];
      this.flightEffects = [];
      // And every transition names a slot in a world that no longer exists.
      this.transitions = [];
      // A target in the old world names nobody in this one, and the server has
      // already dropped it — leaving it set here would draw a red outline
      // around whoever happens to answer to that id next.
      this.targetId = null;
      // Attack mode is *not* cleared: it is this player's stance rather than a
      // fact about the world that was replaced, and a fight interrupted by the
      // editor saving a map should not quietly put your sword away. The body at
      // the other end is new and comes up not swinging, though, so the stance
      // has to be said again — the same resend the held directions do.
      if (this.attacking) this.send({ type: "attackMode", enabled: true });
      this.hps.clear();
      this.carriedLights.clear();
      this.statusesById.clear();
      // Cleared with them and refilled by the `hello` below, which carries
      // everybody's switch in full. Not resent the way attack mode is: the
      // switch is the *server's* state and it carries it across a save itself,
      // so a client that said it again would be telling the far end something
      // it already knows. @see `server/GameServer`'s replaceWorld
      this.pvpOn.clear();
      this.extractionsById.clear();
      this.castingsById.clear();
      // Replaced outright rather than kept: the body at the other end is a
      // fresh one, and what it is carrying is whatever the server just said —
      // not what the body in the previous world had on it.
      this.equipment = message.equipment;
      // Emptied rather than carried or asked for, and it is the *right* answer
      // rather than a convenient one: a body's own spell cooldowns are not
      // durable, so the fresh body at the other end has none. Carrying the old
      // record across would dim a button on a spell nothing is cooling.
      // @see `../game/GameSession`'s `ActorRuntime.spellCooldownMs`
      this.spellCooldowns = {};
      // Same rule, and it matters more here: a fresh body in a replaced world
      // still belongs to the same person, and dropping their tags would hand
      // them every reward in the map a second time.
      this.tags = message.tags;
      // Same rule again, with the one wrinkle that a world replacement *does*
      // reach: `replaceWorld` drops every `spawn:` row, so the server re-mints
      // one and the `hello` carries whatever it came to. Taking it as sent is
      // what keeps this client agreeing with that rather than holding a mark
      // for a building that no longer stands.
      this.spawnAt = message.spawnAt;
      // Same rule a third time. The world may have been replaced under them,
      // but the pull they are half way through is a fact about the last few
      // seconds and the server is still counting it.
      this.setExtracting(message.extracting);
      // And the fight they are half way into, on precisely that rule: the body
      // beside the wolf is the one they left, so the wait is still running.
      this.nextBlow = message.nextBlow ? { ...message.nextBlow } : null;
      // Same rule again: a fresh body in a replaced world is still the same
      // person, and what they have learnt came with them.
      this.masteryXp = message.masteryXp;
      // And what is running on them, for the same reason a third time — the
      // server carries statuses across a world replacement precisely so a save
      // does not cure every poison in the room.
      this.statuses = message.statuses.map((patch) => ({
        defId: patch.defId,
        remainingMs: patch.remainingMs,
        durationMs: patch.durationMs,
        sinceEffectMs: 0,
      }));
      for (const id of message.actorIds) this.motions.set(id, emptyMotion());
      // Emptied first, unlike everything beside it: a `hello` is a new world or
      // a new body, and holding names from the last one would leave a label on
      // a body somebody else is now in.
      this.names.clear();
      this.applyNames(message.names);
      this.applyHps(message.hps);
      this.applyCarriedLights(message.carriedLights);
      this.applyStatusIds(message.statusIds);
      this.applyPvp(message.pvp);
      this.applyExtractions(message.extractions);
      this.applyCastings(message.castings);
      this.setPlayers(message.playerCount);
      // A `hello` is a body, whichever of the two sent it: the answer to
      // `rebirth`, or a world replaced under a socket that happened to be dead
      // in the old one. Either way there is somebody on the board again, and
      // the screen saying otherwise has to come down.
      this.setDead(false);
      this.ready = true;
      this.onReady?.();
      return;
    }

    if (message.type === "chat") {
      // Arrives already scoped to this viewer's level — the server sends it
      // nowhere else — so there is nothing to filter here.
      this.chats.push({
        id: `chat-${this.nextChatId++}`,
        actorId: message.actorId,
        tileId: message.tileId,
        // Off the message rather than out of {@link names}, because the bubble
        // outlives its author: a stranger can say something and walk out of
        // reach before the five seconds are up. @see `../game/GameSession`'s
        // `ChatBubble`
        name: message.name,
        text: message.text,
        x: message.x,
        y: message.y,
        z: message.z,
        stackIndex: message.stackIndex,
        elapsedMs: 0,
      });
      this.evictOldestAtCell(message);
      return;
    }

    if (message.type === "noise") {
      // Scoped to this viewer's level by the server, like chat, so there is
      // nothing to filter here either.
      this.noises.push({
        id: message.id,
        text: message.text,
        x: message.x,
        y: message.y,
        z: message.z,
        stackIndex: message.stackIndex,
        elapsedMs: 0,
      });
      return;
    }

    if (message.type === "stepRejected") {
      this.rollBackFrom(message.seq);
      return;
    }

    if (message.type === "tags") {
      // Whole state, like the kit beside it.
      this.tags = message.tags;
      return;
    }

    if (message.type === "spawnPoint") {
      // Whole state, like the tags above — it is one cell, so there is no
      // incremental form. Held only so the respawn point this player is
      // standing on can draw itself grey; nothing here decides where anybody
      // actually comes back, which is the server's record and its alone.
      this.spawnAt = message.at;
      return;
    }

    if (message.type === "conversation") {
      // Whole state, like the kit and the tags: null closes the panel, whether
      // the viewer pressed Close or walked out of reach.
      this.conversation = message.conversation;
      return;
    }

    if (message.type === "extracting") {
      // Whole state, like everything else addressed to one socket here.
      this.setExtracting(message.extracting);
      return;
    }

    if (message.type === "nextBlow") {
      // Whole state on the terms above, and copied rather than held by
      // reference: this side winds it down every frame, and the object the
      // parser handed over is about to be the only record of what the server
      // said. @see windBars
      this.nextBlow = message.nextBlow ? { ...message.nextBlow } : null;
      return;
    }

    if (message.type === "notice") {
      // Held rather than acted on: what a sentence is worth and how long it
      // stays up are the renderer's questions, and this side's only job is not
      // to lose the line between the socket and the next frame.
      this.pendingNotices.push(message.text);
      return;
    }

    if (message.type === "masteries") {
      // Whole state, like everything else addressed to one socket here.
      this.masteryXp = message.masteryXp;
      return;
    }

    if (message.type === "died") {
      // The kit first, so the panel is right on the frame the screen goes up.
      // It comes on this message rather than on an `equipment` one because
      // there is no longer a body for the server to read one off — see the
      // protocol's note. Normally empty: everything is on the floor where the
      // patch just before this put it.
      this.equipment = message.equipment;
      // And nothing of this body's own is cooling, because there is no longer a
      // body — the row is gone with the screen that replaces it, and what comes
      // back is a fresh one. @see the `hello` above.
      this.spellCooldowns = {};
      // Dropped before the flag rather than left to {@link setInput}'s gate:
      // that gate stops anything *new* arriving, and this is what a key already
      // down when the blow landed leaves behind. A step still pending is in the
      // same position — the socket is silent from here, so no patch is coming
      // that could confirm or refuse it.
      this.held = { directions: [] };
      this.pending = [];
      // Beside them, and for the same reason: a body that no longer exists is
      // not recovering from anything, and a recovery left running would plant
      // the one it comes back in for the rest of its length.
      this.attackRecoveryMs = 0;
      // Stated locally rather than sent, unlike the kit beside it. What is left
      // in the bag is a real question — normally nothing, sometimes the whole
      // kit the cell refused — so the server has to answer it. What a corpse is
      // still poisoned with is not a question: a body off the board carries
      // none, and `flushStatuses` cannot say so because it reads the runtime
      // the death deleted. Left alone, the chips would sit there on a corpse.
      this.statuses = NO_STATUSES;
      this.setDead(true);
      return;
    }

    if (message.type === "equipment") {
      // Whole state, replacing what was here — the same rule hit points follow,
      // and for the same reason: an inventory rebuilt from a stream of adds and
      // removes drifts the moment one is missed and never recovers.
      this.equipment = message.equipment;
      // And the body's own spells' cooldowns beside it, which arrive on this
      // message because they are the same fact about the same caster. @see
      // spellCooldowns
      this.spellCooldowns = message.spellCooldowns;
      return;
    }

    if (message.type === "statuses") {
      // Whole state again, on the terms the kit and the hit points are under. A
      // list rebuilt from gained-and-lost events drifts the moment one is missed
      // and goes on being wrong with nothing to correct it.
      //
      // The cadence accumulator is not on the wire and is not wanted: it is the
      // server's bookkeeping about when the next payout is due, and the client
      // pays nothing out. Zero is the honest local value.
      this.statuses = message.statuses.map((patch) => ({
        defId: patch.defId,
        remainingMs: patch.remainingMs,
        durationMs: patch.durationMs,
        sinceEffectMs: 0,
      }));
      return;
    }

    const leaving = this.applyCells(message.cells);
    this.applyNames(message.names);
    this.applyHps(message.hps);
    this.applyCarriedLights(message.carriedLights);
    this.applyStatusIds(message.statusIds);
    this.applyPvp(message.pvp);
    this.applyExtractions(message.extractions);
    this.applyCastings(message.castings);
    for (const event of message.events) this.applyEvent(event);
    this.forgetDeparted(leaving);
    this.rebuildPredicted();
  };

  /**
   * Hold the pull the server says this player is making.
   *
   * Copied rather than adopted, because {@link update} winds it in place: the
   * parsed message is this client's to spend, and holding the validator's own
   * object would be mutating something nothing else expects to move.
   */
  private setExtracting(extracting: Extraction | null) {
    this.extracting = extracting ? { ...extracting } : null;
  }

  /**
   * What is running on the viewer's own body, as the server last said.
   *
   * Theirs alone: nothing draws anybody else's, so nothing else is ever told.
   * Held here rather than in `this.hps` for exactly that reason — one is a map
   * keyed by actor because a health bar hangs over every head, and this is a
   * single list because there is only ever one body it describes.
   */
  private statuses: readonly StatusInstance[] = NO_STATUSES;

  /**
   * Learn what somebody is called.
   *
   * Nothing is removed here and nothing is corrected: see {@link names}. A
   * body that has left is left in the map on purpose — a bubble it left behind
   * outlives it by five seconds, and so does the skull with its name on it.
   */
  private applyNames(patches: NamePatch[]) {
    for (const patch of patches) this.names.set(patch.actorId, patch.name);
  }

  /** Take the server's word for everybody's hit points. */
  private applyHps(hps: HpPatch[]) {
    for (const patch of hps) {
      this.hps.set(patch.actorId, {
        hp: patch.hp,
        maxHp: patch.maxHp,
        rating: patch.rating,
      });
    }
  }

  /**
   * Take the server's word for what everybody is carrying that glows.
   *
   * An empty list is stored rather than deleted: it is the server saying "this
   * one put their lantern away", and dropping the entry instead would be
   * indistinguishable from never having heard about them.
   */
  private applyCarriedLights(patches: CarriedLightsPatch[]) {
    for (const patch of patches) {
      this.carriedLights.set(patch.actorId, patch.tileIds);
    }
  }

  /**
   * Rebuild what each body is under from the ids the server broadcast.
   *
   * An empty list is stored rather than deleted, on the terms
   * {@link applyCarriedLights} keeps one: it is the server saying "this one is
   * clear now", which is not the same as never having heard about them.
   *
   * The countdown is not on the wire, so every instance is built with
   * {@link UNKNOWN_REMAINING_MS} — which falls through `taperAt` as "not winding
   * down". Somebody else's poison therefore burns at full strength until it
   * ends, and that is the documented trade rather than a bug to fix here.
   */
  private applyStatusIds(patches: StatusIdsPatch[]) {
    for (const patch of patches) {
      this.statusesById.set(
        patch.actorId,
        patch.defIds.map((defId) => ({
          defId,
          remainingMs: UNKNOWN_REMAINING_MS,
          durationMs: UNKNOWN_REMAINING_MS,
          sinceEffectMs: 0,
        })),
      );
    }
  }

  /**
   * Take the server's word for who is part-way through a pull.
   *
   * Deleted on null rather than stored, unlike {@link applyStatusIds}' empty
   * list: "stopped pulling" and "never heard of them" draw the same nothing.
   * Copied rather than adopted, on {@link setExtracting}'s terms, because
   * {@link windBars} winds these in place.
   */
  /**
   * Take the server's word for who is fighting other players.
   *
   * Absent means off, so an entry is deleted rather than stored false — the
   * same shape {@link applyExtractions} keeps for a pull that has stopped, and
   * for the same reason: "not fighting" and "never heard about them" draw the
   * same nothing. @see `../game/pvp`
   */
  private applyPvp(patches: PvpPatch[]) {
    for (const patch of patches) {
      if (patch.on) this.pvpOn.add(patch.actorId);
      else this.pvpOn.delete(patch.actorId);
    }
  }

  private applyExtractions(patches: ExtractionPatch[]) {
    for (const patch of patches) {
      if (patch.progress) {
        this.extractionsById.set(patch.actorId, { ...patch.progress });
      } else {
        this.extractionsById.delete(patch.actorId);
      }
    }
  }

  /**
   * Take the server's word for who is part-way through a cast.
   *
   * {@link applyExtractions}' twin, on every one of its terms: deleted on null,
   * and copied because {@link windBars} winds these in place.
   */
  private applyCastings(patches: CastingPatch[]) {
    for (const patch of patches) {
      if (patch.progress) {
        this.castingsById.set(patch.actorId, { ...patch.progress });
      } else {
        this.castingsById.delete(patch.actorId);
      }
    }
  }

  /**
   * How fast the body at `at` walks, with whatever is slowing or hurrying it.
   *
   * Taken from the top of the stack, which is where a body sits. A cell that
   * has already been patched out from under the event falls back to the
   * player's pace — the wrong answer for one step of one creature, and better
   * than refusing to animate it.
   *
   * **Derived here rather than sent, which is what constrains what may move a
   * pace.** The statuses are the ids the broadcast carries, and the percentage
   * each one is worth is a plain number in the catalogue — so this side reaches
   * the same answer the simulation did without a countdown it does not have for
   * anybody but its viewer. @see `../lib/status`'s `StatusDef.walkSpeedPercent`
   */
  private walkDurationAt(actorId: string, at: { x: number; y: number; z: number }): number {
    const stack = getStack(this.map, at.x, at.y, at.z);
    const def = this.tilesById[stack[stack.length - 1]?.tileId ?? ""];
    if (!def) return WALK_DURATION_MS;
    return walkDurationMsFor(
      def,
      this.walkSpeedPercentOf(actorId) +
        groundWalkSpeedPercent(
          this.map,
          // The body is the top of the stack, which is what the def above was
          // read off — so the ground it is standing on is everything under it.
          { ...at, stackIndex: stack.length - 1 },
          this.tilesById,
        ),
    );
  }

  /**
   * What the viewer's own body fights and walks at.
   *
   * **Derived here rather than sent, which is the same bargain
   * {@link walkDurationAt} is under** — and it is available for exactly one
   * body. The note in `docs/notes.md` says the browser never builds
   * `FightingStats` because it does not know what anybody is wearing or what
   * they have practised; that is true of everybody *else*. What the viewer is
   * carrying arrives on the equipment channel and what they have learnt arrives
   * on the mastery one, both theirs alone, so their own block is the one the
   * browser can reach without a field on the wire that would go stale between
   * the two.
   *
   * The masteries come out of the experience through `masteriesFromXp`, which is
   * the same route `GameSession.bodyOf` takes to the same numbers — a second
   * reading here would be a panel quoting a level the fight does not use.
   *
   * **Null exactly when the health reading is**, which is the gate rather than a
   * second opinion: `maxHp` is the snapshot's own answer to "is this a battler",
   * it is null on the stand-in body a viewer has before their first `hello`, and
   * a panel that said what a body with no hit points hits for would be
   * describing nobody. The tile's own block is checked as well, for the tile
   * that has lost its battler under a body the server is still reporting.
   */
  private attributesOf(self: ActorSnapshot): Attributes | null {
    if (self.maxHp === null) return null;
    const bodyDef = this.tilesById[self.tileId];
    const authored = bodyDef ? resolveBattler(bodyDef) : null;
    if (!bodyDef || !authored) return null;
    return attributesOf({
      body: { ...authored, masteries: masteriesFromXp(this.masteryXp) },
      bodyDef,
      equipment: this.equipment,
      tilesById: this.tilesById,
      // The viewer's own list, with the countdowns the server addressed to them
      // — which is what a modifier formula reading `REMAINING_SEC` needs, and
      // what nobody else's broadcast ids could supply. @see applyStatusIds
      statuses: this.statuses,
      statusDefs: this.statusDefs,
      hp: self.hp,
    });
  }

  /**
   * How much quicker or slower everything on one body makes it walk.
   *
   * The viewer's own list where there is one and the broadcast ids otherwise,
   * which is the same split {@link getSnapshot} draws statuses by — and here it
   * costs nothing, because the percentage a status is worth does not depend on
   * how long it has left.
   */
  private walkSpeedPercentOf(actorId: string): number {
    const statuses =
      actorId === this.selfId ? this.statuses : (this.statusesById.get(actorId) ?? NO_STATUSES);
    return walkSpeedPercentFrom(statuses, this.statusDefs);
  }

  /**
   * Cells are whole-stack replacements, applied in one `setStacks` call so each
   * affected chunk is copied once — the same discipline the simulation uses for
   * a multi-cell edit.
   *
   * Applied to the server's board rather than the drawn one. The drawn board is
   * derived — see {@link rebuildPredicted} — and writing a patch straight into
   * it would bake this client's guesses into the very thing that is supposed to
   * be able to correct them.
   *
   * @returns who these cells may have taken off the board; see
   *   {@link forgetDeparted}, which is the caller's next-but-one step.
   */
  private applyCells(cells: CellPatch[]): readonly string[] {
    if (cells.length === 0) return NO_OWNERS;
    const leaving = this.ownersLeaving(cells);
    this.serverMap = setStacks(this.serverMap, cells);
    return leaving;
  }

  /**
   * Owners these patches take out of a cell without putting into another.
   *
   * The candidates for having left the world entirely, and only the candidates:
   * a step patches the cell behind and the cell ahead in one batch, so a walker
   * is in the new stacks and never costs the board search {@link forgetDeparted}
   * would otherwise run on every creature that moved this tick.
   *
   * Read off the board before {@link applyCells} overwrites it, which is the
   * whole reason this is a separate pass rather than part of the loop that
   * forgets them.
   */
  private ownersLeaving(cells: CellPatch[]): readonly string[] {
    const left = new Set<string>();
    for (const cell of cells) {
      for (const placed of getStack(this.serverMap, cell.x, cell.y, cell.z)) {
        // Our own body is never judged by its absence; see
        // {@link forgetDeparted}.
        if (placed.owner && placed.owner !== this.selfId) left.add(placed.owner);
      }
    }
    if (left.size === 0) return NO_OWNERS;
    for (const cell of cells) {
      for (const placed of cell.stack) {
        if (placed.owner) left.delete(placed.owner);
      }
    }
    return left.size === 0 ? NO_OWNERS : [...left];
  }

  /**
   * Forget the actors this frame took off the board for good.
   *
   * A death is not on the wire — the body simply stops being in any cell — so
   * absence from the board the server just described is the only thing that
   * says it happened. Which is enough here, and is *not* enough for this
   * client's own body: see {@link dead} for why that one is told rather than
   * inferred, and {@link ownersLeaving} for where it is excluded.
   *
   * What this leaves behind if it is not done is a reservation nobody can ever
   * release. {@link releaseArrivedWalk} ends another actor's walk when the map
   * moves them out of the cell it started in, and a creature killed mid-step
   * never moves anywhere again — so its `walk.to` sits in {@link motions} for
   * the rest of the session and {@link destinationTaken} goes on refusing that
   * cell to the player who just cleared it. Reconnecting was the only cure,
   * because a `hello` clears the table.
   *
   * Run after the frame's events rather than beside the patch that carries
   * them: a creature that started a step and was killed in the same tick is
   * announced in both, and forgetting it first would leave the walk event to
   * put the reservation straight back.
   */
  private forgetDeparted(leaving: readonly string[]) {
    for (const id of leaving) {
      // Already gone from this client's set, which this frame's `despawned`
      // does for a body that walked out of what it is subscribed to. Asking
      // where it is would be the whole-board search below, run to decide
      // whether to forget something already forgotten. @see `./scope`
      if (!this.motions.has(id)) continue;
      if (locateActor(this.serverMap, id)) continue;
      this.forgetActor(id);
    }
  }

  /**
   * Drop everything this client is holding about somebody who is gone.
   *
   * One place for it because there are two ways to go — a socket closing and a
   * death — and nothing about what a client remembers distinguishes them.
   */
  private forgetActor(id: string) {
    this.motions.delete(id);
    this.hps.delete(id);
    this.carriedLights.delete(id);
    this.statusesById.delete(id);
    this.pvpOn.delete(id);
    // Beside the statuses, and they were missing here: nothing draws a bar for
    // a body that is not in {@link motions}, so a left-behind row sat inert
    // until the same id came back — which a respawned resident does, under the
    // name it died with. @see applyExtractions
    this.extractionsById.delete(id);
    this.castingsById.delete(id);
    if (this.targetId === id) this.targetId = null;
  }

  private applyEvent(event: MotionEvent) {
    if (event.kind === "joined") {
      this.motions.set(event.actorId, emptyMotion());
      this.setPlayers(event.playerCount);
      return;
    }
    if (event.kind === "left") {
      this.forgetActor(event.actorId);
      this.setPlayers(event.playerCount);
      return;
    }

    // A body the world took on after this client's `hello`, or one that has come
    // back into what this client is subscribed to. Added only if it is new,
    // because the same id can arrive twice — a socket that connected just after
    // the spawn was already told about it by name — and `emptyMotion()` over a
    // body mid-stride would drop the lerp it is halfway through.
    //
    // Its bar and its lantern come from the diffs beside this in the same
    // frame. What this carries is that there is somebody to hang them on, and
    // the cell to start looking in.
    if (event.kind === "spawned") {
      if (!this.motions.has(event.actorId)) {
        const motion = emptyMotion();
        // The cell the server says its tile is in, taken as the last place this
        // client saw it. Without it the first {@link locate} has nothing to
        // confirm and falls through to a search of the whole board — once per
        // body coming into reach, which with a moving subscription is every
        // creature a player walks past. It is confirmed like any other last
        // known cell, so a patch that has already moved the body on costs the
        // neighbourhood search and not a wrong answer.
        motion.lastSeen = event.at;
        this.motions.set(event.actorId, motion);
      }
      return;
    }

    // A body this client is no longer being kept current about, because it is
    // no longer standing on ground this client holds. Not a death: the world
    // still has it, and walking back into reach announces it again.
    //
    // What must not be left behind is the entry itself — {@link locate} reads a
    // body's position off this client's own board, and for a body it has no
    // cell for that is a search of the whole board, every frame. @see `./scope`
    if (event.kind === "despawned") {
      this.forgetActor(event.actorId);
      return;
    }

    if (event.kind === "damage") {
      this.damage.push({
        id: event.id,
        targetId: event.targetId,
        outcome: event.outcome,
        amount: event.amount,
        x: event.x,
        y: event.y,
        z: event.z,
        stackIndex: event.stackIndex,
        elapsedMs: 0,
      });
      return;
    }

    // Before the prediction guard below, on exactly the grounds the lean is: an
    // arrow is not a claim about where any body *is*, so it can neither confirm
    // nor contradict a step this client is holding a guess about. It carries no
    // actor id at all, which is the shortest way of saying the same thing.
    if (event.kind === "projectileFired") {
      // An id the catalogue has lost, or one naming a tile that is not a
      // projectile, is a shot nobody can draw — so nothing goes in the air: a
      // flight with no speed has no duration. The blow it was a receipt for
      // landed in this same frame, which is the part that mattered.
      const def = this.tilesById[event.tileId];
      const flies = resolveProjectile(def);
      if (!flies) return;
      const flight: ProjectileFlight = {
        id: event.id,
        tileId: event.tileId,
        from: event.from,
        to: event.to,
        // Carried through so this client can draw the shot following its
        // target, which is the whole of what the id is for.
        ...(event.targetId ? { targetId: event.targetId } : {}),
        // Derived rather than heard, which is the whole of what the catalogue
        // bought: both sides run the same `flightDurationMs` over the same two
        // points and the same entry, so there is no third number to disagree
        // with. @see `./protocol`
        durationMs: flightDurationMs(event.from, event.to, flies),
        elapsedMs: 0,
        hit: event.hit,
      };
      this.projectiles.push(flight);
      beginEffect(flight, "appear", flight.from, def, this.flightEffects);
      return;
    }

    if (event.kind === "teleported") {
      // Nothing to animate — the body is simply somewhere else, and the cell
      // patches in this same frame say where. What has to happen is that both
      // the lerp and, for our own body, the prediction stop: a walk still being
      // drawn would drag the sprite across the map from a cell nobody is in.
      this.motions.set(event.actorId, emptyMotion());
      if (event.actorId === this.selfId) this.abandonPrediction();
      return;
    }

    // Before the prediction guard below, and that placement is the whole of the
    // care this needs: a lean is not a claim about where a body *is* — the
    // striker never leaves its cell — so it can neither confirm nor contradict a
    // step this client is holding a guess about. Run through that guard, every
    // swing a walking player took would throw their own footwork away.
    //
    // The opposite of the teleport above, which is worth reading beside it: that
    // one moves a body without animating, this one animates without moving one.
    if (event.kind === "strikeStarted") {
      const striking = this.motions.get(event.actorId) ?? emptyMotion();
      this.motions.set(event.actorId, striking);
      striking.strike = {
        kind: event.strike,
        dx: event.dx,
        dy: event.dy,
        dElev: event.dElev,
        elapsedMs: 0,
      };
      return;
    }

    // Before the prediction guard, with the others that move nobody: a tile
    // forming or dissolving is not a claim about where any body is, and it
    // carries no actor for the guard to ask about.
    if (event.kind === "tileTransition") {
      const { kind: _kind, ...note } = event;
      this.holdTransition(note);
      return;
    }

    // Before the prediction guard for the third time, and for the reason the
    // two above are: a blow moves nobody, so it can neither confirm nor
    // contradict a step this client is holding a guess about. Run through that
    // guard, it would throw away the footwork of everybody who swung mid-stride
    // — which is exactly the step a recovery lets through, since only the start
    // of one is ever gated.
    //
    // Only our own, because a recovery is only ever asked about by the body
    // predicting its own steps. @see `./protocol`
    if (event.kind === "swung") {
      if (event.actorId !== this.selfId) return;
      const def = this.tilesById[PLAYER_TILE_ID];
      // The body's own pace, not the constant, so a player authored to walk
      // slowly is planted for two of *their* steps — the same reading the
      // simulation takes. @see `../game/combat`'s `strikeRecoveryMs`
      this.attackRecoveryMs = def
        ? strikeRecoveryMs(def)
        : WALK_DURATION_MS * STRIKE_RECOVERY_STEPS;
      // And the aim is planted with the body, which on this side means giving
      // the facing back to the server for the length of it. The turn into the
      // target was made by the tick that threw the blow and arrives in the same
      // patch as this event; held locally, {@link facing} would paint over it
      // with whichever way the player is running. @see rebuildPredicted
      this.facing = null;
      return;
    }

    if (event.actorId === this.selfId) {
      // A walk of our own is one we drew a round trip ago and are still holding
      // a guess about; this is the server agreeing, not news, and replaying it
      // would restart a lerp that has already finished.
      if (event.kind === "walkStarted" && this.pending.length > 0) return;
      // Anything else it does to us is motion this client never predicted — a
      // fall above all — so whatever it thought it was doing is void.
      this.abandonPrediction();
    }

    const motion = this.motions.get(event.actorId) ?? emptyMotion();
    this.motions.set(event.actorId, motion);

    if (event.kind === "walkStarted") {
      motion.walk = {
        from: event.from,
        to: event.to,
        direction: event.direction,
        elapsedMs: 0,
        // Read off the body rather than sent with the event: this side already
        // knows which tile is walking, so deriving the pace here cannot
        // disagree with the server and costs nothing on the wire.
        durationMs: this.walkDurationAt(event.actorId, event.from),
      };
    } else if (event.kind === "fallStarted") {
      motion.fall = {
        feetAbs: event.feetAbs,
        landingAbs: event.landingAbs,
        elapsedMs: 0,
      };
    } else {
      motion.slide = {
        object: event.object,
        from: event.from,
        count: event.count,
        elapsedMs: 0,
      };
    }
  }

  /**
   * Advance local animation clocks.
   *
   * A finished walk is held at its destination rather than dropped, because the
   * timer running out is not the same event as the step becoming true. The
   * server announces the walk when it starts and commits it 200ms later, so the
   * patch lands one network latency after the lerp ends — drop the lerp on the
   * timer and the sprite falls back to the cell it is still standing in for
   * those few frames, then jumps forward again when the patch arrives. That is
   * the twitch. {@link releaseArrivedWalk} ends the walk on the patch instead.
   *
   * None of which applies to this client's own walking, which is predicted: it
   * lands on its own timer because this side is the one that decided it, and
   * {@link landPredictedStep} is what commits it.
   */
  update(dtMs: number) {
    for (const [id, motion] of this.motions) {
      if (motion.walk) {
        // A predicted walk is allowed past its own duration; every other walk
        // is held at it. The overshoot is not wasted time, it is the part of
        // the frame that belongs to the *next* step, and
        // {@link landPredictedStep} hands it on. Rounded away instead, a step
        // would cost a whole frame more than it should — 208ms at 60fps, 231ms
        // at 30fps — and how fast you walk would depend on your frame rate.
        motion.walk.elapsedMs = this.isPredicting(id)
          ? motion.walk.elapsedMs + dtMs
          : Math.min(motion.walk.durationMs, motion.walk.elapsedMs + dtMs);
      }
      // Mirrors the simulation's own fall: feet step down one height unit at a
      // time, and progress is the fraction of the *current* unit — which is
      // what the renderer subtracts from feetAbs to place the sprite. A fall
      // that has reached its landing stops advancing and waits to be released,
      // for the same reason a finished walk does; see {@link releaseLandedFall}.
      const fall = motion.fall;
      if (fall && fall.feetAbs > fall.landingAbs) {
        fall.elapsedMs += dtMs;
        while (fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
          fall.elapsedMs -= FALL_MS_PER_HEIGHT;
          const nextFeet = fall.feetAbs - 1;
          if (nextFeet <= fall.landingAbs) {
            fall.feetAbs = fall.landingAbs;
            fall.elapsedMs = 0;
            break;
          }
          fall.feetAbs = nextFeet;
        }
      }
      if (motion.slide) {
        motion.slide.elapsedMs += dtMs;
        if (motion.slide.elapsedMs >= PUSH_STEP_MS) motion.slide = null;
      }
      // Dropped on its own timer, unlike a walk or a fall: there is no patch
      // coming to confirm it, because a strike changes nothing about the board.
      if (motion.strike) {
        motion.strike.elapsedMs += dtMs;
        if (motion.strike.elapsedMs >= STRIKE_DURATION_MS) motion.strike = null;
      }
    }

    // Before the prediction below rather than after it, so a recovery that runs
    // out this frame is a step taken this frame. Left until afterwards, every
    // blow would cost a frame more than it says it does, and how much more
    // would depend on the frame rate.
    if (this.attackRecoveryMs > 0) {
      this.attackRecoveryMs = Math.max(0, this.attackRecoveryMs - dtMs);
    }
    this.windBars(dtMs);
    this.agePendingSteps(dtMs);
    this.advancePrediction();
    this.expireChats(dtMs);
    this.expireNoises(dtMs);
    this.expireDamage(dtMs);
    this.expireProjectiles(dtMs);
  }

  /**
   * Every tile transition heard since the last call that could still be
   * running, with how long ago it was heard, handed over and forgotten.
   *
   * The renderer's to call once a frame. It owns how far along each one is, and
   * the age is what lets it start one that waited where it would have been
   * rather than from the beginning.
   */
  takeTransitions(): HeldTransition[] {
    const at = this.now();
    const taken: HeldTransition[] = [];
    for (const held of this.transitions) {
      const ageMs = at - held.heardAtMs;
      if (ageMs < MAX_TRANSITION_MS) taken.push({ note: held.note, ageMs });
    }
    this.transitions = [];
    return taken;
  }

  /**
   * Keep a note for the renderer, dropping anything that could have finished
   * and then the oldest past the cap.
   *
   * Against the longest a transition may be rather than its own duration, so
   * this side never has to look a tile up to know when it is done with one.
   */
  private holdTransition(note: TileTransitionNote) {
    const at = this.now();
    this.transitions = this.transitions.filter((held) => at - held.heardAtMs < MAX_TRANSITION_MS);
    this.transitions.push({ note, heardAtMs: at });
    if (this.transitions.length > MAX_HELD_TRANSITIONS) this.transitions.shift();
  }

  /**
   * Wind every pull and every cast on against the render clock.
   *
   * **Local, and not a prediction of anything.** The server is still the only
   * thing that decides when a pull lands or is taken away — its message is what
   * clears this, and nothing here ever does. What this keeps true is the
   * *number*, which the bar on the row is a fraction of: the wire carries a
   * pull twice, at its start and at its end, so between those two the client is
   * the only thing that knows any time has passed.
   *
   * Floored rather than allowed negative, and the value is kept at zero: a bar
   * that has filled reads as "any moment now", which is exactly true — the
   * message clearing it is at most a tick away.
   *
   * Wound in place, so the value handed to the snapshot keeps its identity and
   * the interaction rows are not rebuilt thirty times a second. The same
   * hand-over the motions above travel on.
   *
   * Everybody else's pull is wound the same way and for the same reason: the
   * broadcast carries it twice too, and the bar over their head is the same
   * fraction. A cast is that same bargain a third time.
   */
  private windBars(dtMs: number) {
    if (this.extracting) windProgress(this.extracting, dtMs);
    // The fight's own clock, on exactly the same bargain: the outline round a
    // target fills from this, and the server says so twice a wait.
    if (this.nextBlow) windProgress(this.nextBlow, dtMs);
    for (const running of this.extractionsById.values()) {
      windProgress(running, dtMs);
    }
    // Casts on the same clock and for the same reason, the viewer's own
    // included: the broadcast carries both halves of the fraction twice a cast,
    // and the bar in between is this side's to fill.
    for (const casting of this.castingsById.values()) {
      windProgress(casting, dtMs);
    }
  }

  /**
   * Land the arrows that have arrived, and play what their landings owe.
   *
   * Timed off the render loop's delta exactly as the numbers above are — and,
   * exactly as they are, with nothing to commit: there was never anything for
   * the arrow to *do* on arrival, since the blow it depicts was settled on the
   * tick it was loosed. What it leaves is the same receipt drawn where it
   * stopped, and which side that is was decided by the server.
   * @see `../game/projectile`
   *
   * The arithmetic is shared with the simulation's own aging rather than
   * repeated here: the clocks differ — a tick there, a frame here — but the
   * rule that a landing plays a side is one rule.
   *
   * Each flight carries its own duration rather than sharing a constant, unlike
   * every other motion here: how long a shot takes depends on how far it went.
   */
  private expireProjectiles(dtMs: number) {
    if (this.projectiles.length > 0) {
      this.projectiles = ageFlights(this.projectiles, dtMs, this.tilesById, this.flightEffects);
    }
    if (this.flightEffects.length > 0) {
      this.flightEffects = ageEffects(this.flightEffects, dtMs);
    }
  }

  /**
   * Age the floating numbers out.
   *
   * Timed off the render loop's delta exactly as the bubbles are, so the server
   * announces a blow once and never has to think about it again — no timer
   * holding an idle world awake for the sake of something that is only being
   * drawn.
   */
  private expireDamage(dtMs: number) {
    if (this.damage.length === 0) return;
    let expired = false;
    for (const number of this.damage) {
      number.elapsedMs += dtMs;
      if (number.elapsedMs >= DAMAGE_NUMBER_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.damage = this.damage.filter((number) => number.elapsedMs < DAMAGE_NUMBER_LIFETIME_MS);
    }
  }

  /**
   * Land whatever finished this frame, and start what comes next.
   *
   * A loop rather than a single pass, because one frame is not always one step:
   * a tab coming back from the background, or a device that dropped a few
   * hundred milliseconds, arrives with enough elapsed time for more than one.
   * Walking them all is what keeps a step worth 200ms of the world's time
   * rather than 200ms of *drawn* time.
   *
   * Bounded by how far ahead this client is willing to be anyway, so a stall
   * measured in seconds stops rather than sprinting off across the map.
   */
  private advancePrediction() {
    for (let taken = 0; taken < MAX_PREDICTED_STEPS; taken++) {
      const carryMs = this.landPredictedStep();
      this.predictStep(carryMs ?? 0);
      if (carryMs === null) return;
    }
  }

  /** Is this actor's current walk one this client drew for itself? */
  private isPredicting(id: string): boolean {
    if (id !== this.selfId) return false;
    const last = this.pending[this.pending.length - 1];
    return last ? !last.landed : false;
  }

  /**
   * Give up on a step nobody ever answered for.
   *
   * Only the oldest is timed, because they are confirmed in order: while the
   * front of the queue is moving, everything behind it is being answered too.
   */
  private agePendingSteps(dtMs: number) {
    const oldest = this.pending[0];
    if (!oldest) return;
    oldest.waitedMs += dtMs;
    if (oldest.waitedMs >= oldest.durationMs + STEP_CONFIRM_GRACE_MS) {
      this.abandonPrediction();
    }
  }

  /**
   * Put a finished step into the predicted board.
   *
   * The moment the lerp ends, not the moment the server confirms it — which is
   * the whole of what makes walking feel immediate. Holding the sprite at the
   * destination until the patch arrives is right for *other* people's walks,
   * because their next step is news that has not reached us; ours is not news,
   * so the actor arrives, the cell under them becomes true locally, and the next
   * step can be chosen from it without a pause.
   *
   * @returns the milliseconds the step overran by, which belong to the step
   *   after it, or null when nothing landed.
   */
  private landPredictedStep(): number | null {
    const motion = this.motions.get(this.selfId);
    const walk = motion?.walk;
    if (!motion || !walk || walk.elapsedMs < walk.durationMs) return null;

    const step = this.pending.find((pending) => !pending.landed);
    if (!step) return null;

    const at = locateActor(this.map, this.selfId, motion.lastSeen ?? undefined);
    if (!at) return null;

    const carryMs = walk.elapsedMs - walk.durationMs;

    this.map = moveEntity(this.map, at, step.to, step.direction, this.tilesById);
    step.landed = true;
    motion.walk = null;
    // moveEntity appends, so the actor is the top of the destination stack.
    // Recorded rather than searched for: the hint is what keeps locating an
    // actor a cell read, and it is exactly known here.
    const stack = getStack(this.map, step.to.x, step.to.y, step.to.z);
    motion.lastSeen = { ...step.to, stackIndex: stack.length - 1 };
    return carryMs;
  }

  /**
   * Take the next step the player is asking for, if the board allows it.
   *
   * Run both from the frame loop — so a held key chains step after step — and
   * straight off the key event in {@link setInput}, so the first one does not
   * wait for the next frame.
   *
   * @param elapsedMs how far into this step the frame that started it already
   *   is; see {@link landPredictedStep}.
   */
  private predictStep(elapsedMs = 0) {
    if (this.held.directions.length === 0) return;

    const motion = this.motions.get(this.selfId);
    if (!motion || motion.walk || motion.fall || motion.slide) return;
    if (this.pending.length >= MAX_PREDICTED_STEPS) return;

    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) return;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return;

    // A step into a hole is a legal step — `canWalk` allows it so that gravity
    // can pull the body through a drop too steep to climb down — and it lands
    // the body in mid-air. The fall that follows is the server's to announce,
    // and until it arrives `motion.fall` above says nothing: on a link with any
    // latency at all this side has already landed the step, still has the
    // direction pressed, and would chain a second one out of a cell nobody is
    // standing in. The server refuses that step, because the simulation refuses
    // every step from a falling body, so what the player sees is their avatar
    // walking one cell past the hole and being dragged back into it.
    //
    // Asking the board is the whole fix, and it is the same question the
    // simulation asks before it starts a fall. @see ../game/gravity
    if (gravityPullOn(this.map, loc, def, this.tilesById).kind === "fall") {
      return;
    }

    const choice = chooseStep(this.map, loc, this.held, def, this.tilesById, (to) =>
      this.destinationTaken(to),
    );
    if (!choice) return;

    // Before the turn, exactly where the simulation gates it: a blow plants the
    // aim with the body, so neither side lets a held key turn a body that has
    // just swung. Drawn in the same place on both sides or a planted player
    // faces their target here and their escape route there.
    // @see `../game/GameSession`'s `applyStepRequest`
    if (this.attackRecoveryMs > 0) return;

    this.face(loc, choice.facing);
    if (!choice.step) return;
    // And a cast roots you, on the same terms and for the same reason this side
    // asks at all: the server refuses the step, so a client that predicted one
    // would walk the body a cell and have it dragged back. Read off the
    // broadcast rather than predicted — the cast is the server's clock — which
    // means the root outlasts the cast by the round trip that clears it. The
    // same lateness the cooldown on a button has, and the same trade.
    if (this.castingsById.get(this.selfId)) return;

    const seq = this.nextStepSeq++;
    // Our own body, so its pace is the one the server will time us by — whatever
    // we are under and whatever we are standing on included. Read once and used
    // twice: it times the lerp, and it is what the backstop below has to wait
    // out before a missing confirmation means anything.
    const durationMs = walkDurationMsFor(
      def,
      this.walkSpeedPercentOf(this.selfId) + groundWalkSpeedPercent(this.map, loc, this.tilesById),
    );
    motion.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs,
      durationMs,
    };
    this.pending.push({
      seq,
      to: choice.step.to,
      direction: choice.step.direction,
      landed: false,
      waitedMs: 0,
      durationMs,
    });
    this.send({
      type: "step",
      seq,
      direction: choice.step.direction,
      preferDescend: Boolean(this.held.preferDescend),
    });
  }

  /**
   * Turn, locally and on the wire.
   *
   * Sent only when the facing actually changes. A held key asks for the same
   * one every frame, and the server has no more use for the ninetieth copy of
   * "still facing east" than it had for the held-direction stream this replaced.
   */
  private face(loc: Coord & { stackIndex: number }, direction: Direction) {
    this.map = setEntityDirection(this.map, loc.x, loc.y, loc.z, loc.stackIndex, direction);
    if (this.facing === direction) return;
    this.facing = direction;
    this.send({ type: "face", direction });
  }

  /**
   * Is another actor already walking into this cell?
   *
   * The same question the simulation asks, answered from the same evidence: a
   * walk is not in the map until it lands, so the only sign of one is the event
   * that announced it. Asked here so that stepping into a cell a creature is
   * already claiming is a step this client never draws, rather than one the
   * server takes back.
   *
   * Somebody else's body is not such a claim — people share cells, so a person
   * walking where we are walking is two people arriving, which is allowed. The
   * simulation reserves on exactly these terms and the two must agree: a client
   * refusing a step the server would grant is a doorway that stutters for no
   * reason anybody can see. @see ../game/GameSession's `destinationTaken`
   */
  private destinationTaken(to: Coord): boolean {
    for (const [id, motion] of this.motions) {
      if (id === this.selfId) continue;
      const other = motion.walk?.to;
      if (!other || other.x !== to.x || other.y !== to.y || other.z !== to.z) {
        continue;
      }
      const loc = this.locate(id, motion);
      if (loc && isPlayerBody(loc.placed)) continue;
      return true;
    }
    return false;
  }

  /**
   * Rebuild the drawn board: what the server says, plus what we have not been
   * answered about yet.
   *
   * Replayed from the server's board every time rather than patched in place,
   * because a guess cannot be edited out of a board it was mixed into. The
   * replay is at most a handful of single-tile moves, and the map is
   * copy-on-write, so this touches the two chunks each step spans and nothing
   * else.
   */
  private rebuildPredicted() {
    const at = locateActor(this.serverMap, this.selfId, this.serverSeen ?? undefined);
    this.serverSeen = at;

    if (!at) {
      // Not on the authoritative board at all — before the first patch that
      // carries us, or between a despawn and a respawn. Nothing to predict from.
      this.pending = [];
      this.map = this.serverMap;
      return;
    }

    this.dropConfirmedSteps(at);

    let map = this.serverMap;
    let loc: Coord & { stackIndex: number } = at;
    for (const step of this.pending) {
      // The step in flight is still being drawn out of the cell below it, which
      // is where the board has to keep holding the actor.
      if (!step.landed) break;
      if (!actorStillAt(map, this.selfId, loc)) {
        this.abandonPrediction();
        return;
      }
      map = moveEntity(map, loc, step.to, step.direction, this.tilesById);
      const stack = getStack(map, step.to.x, step.to.y, step.to.z);
      loc = { ...step.to, stackIndex: stack.length - 1 };
    }

    if (this.facing) {
      map = setEntityDirection(map, loc.x, loc.y, loc.z, loc.stackIndex, this.facing);
    }
    this.map = map;
  }

  /**
   * Retire the steps the server has caught up with.
   *
   * A step is confirmed when the authoritative board has the actor standing on
   * its destination — the patch that commits it *is* the acknowledgement, so
   * nothing extra travels for the overwhelmingly common case of a step simply
   * being allowed.
   *
   * Strictly from the front, never by searching. Walking east and back west
   * again puts the starting cell in the queue twice, and a search would read
   * "still standing where you began" as proof that both had happened.
   */
  private dropConfirmedSteps(at: Coord) {
    while (this.pending.length > 0) {
      const step = this.pending[0]!;
      if (step.to.x !== at.x || step.to.y !== at.y || step.to.z !== at.z) return;
      this.pending.shift();
      // The server got there before the lerp did, which only happens on a link
      // fast enough for the round trip to beat the walk. Drop the animation
      // rather than let it drag a tile that has already arrived.
      if (!step.landed) {
        const motion = this.motions.get(this.selfId);
        if (motion) motion.walk = null;
      }
    }
  }

  /**
   * Undo a refused step, and everything drawn after it.
   *
   * The later steps go whatever the board says about them: each was chosen from
   * the cell the refused one would have reached, so with that cell taken away
   * none of them was ever a step from anywhere the actor stood.
   */
  private rollBackFrom(seq: number) {
    const at = this.pending.findIndex((step) => step.seq === seq);
    if (at < 0) return;
    this.pending.length = at;
    const motion = this.motions.get(this.selfId);
    if (motion) motion.walk = null;
    this.rebuildPredicted();
  }

  /** Drop every guess and stand where the server says. */
  private abandonPrediction() {
    if (this.pending.length === 0) return;
    this.pending = [];
    const motion = this.motions.get(this.selfId);
    if (motion) motion.walk = null;
    this.map = this.serverMap;
  }

  /**
   * Hold one cell to {@link MAX_CHATS_PER_CELL} bubbles.
   *
   * Bubbles at a coordinate stack upward, so an unbounded column would climb the
   * screen and bury the world. The oldest goes the moment a fourth lands rather
   * than being allowed to serve out its five seconds — what a reader wants from
   * a busy cell is the newest line, not the one that got there first.
   *
   * Insertion order is age order, so the first match is the oldest.
   */
  private evictOldestAtCell(at: { x: number; y: number; z: number }) {
    const here = this.chats.filter((chat) => chat.x === at.x && chat.y === at.y && chat.z === at.z);
    if (here.length <= MAX_CHATS_PER_CELL) return;
    const doomed = new Set(here.slice(0, here.length - MAX_CHATS_PER_CELL));
    this.chats = this.chats.filter((chat) => !doomed.has(chat));
  }

  /**
   * Age the bubbles out.
   *
   * Timed off the render loop's own delta, exactly like the motions above, so
   * the server announces a message once and never has to think about it again —
   * no five-second timer holding an idle world awake. The cost is that a
   * backgrounded tab holds its bubbles the same way it holds a half-finished
   * walk, which is the behaviour those already have.
   */
  private expireChats(dtMs: number) {
    if (this.chats.length === 0) return;
    let expired = false;
    for (const chat of this.chats) {
      chat.elapsedMs += dtMs;
      if (chat.elapsedMs >= CHAT_LIFETIME_MS) expired = true;
    }
    // Rebuilt only when something actually went, so a screen full of live
    // bubbles does not allocate a new array every frame.
    if (expired) {
      this.chats = this.chats.filter((chat) => chat.elapsedMs < CHAT_LIFETIME_MS);
    }
  }

  /**
   * Age the noises out, on the render loop's clock like the bubbles above.
   *
   * No per-cell eviction, unlike chat: a noise is short by construction — the
   * field it comes from is capped at a word — so a stack of them cannot wall
   * off the view the way a stack of sentences can.
   */
  private expireNoises(dtMs: number) {
    if (this.noises.length === 0) return;
    let expired = false;
    for (const noise of this.noises) {
      noise.elapsedMs += dtMs;
      if (noise.elapsedMs >= NOISE_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.noises = this.noises.filter((noise) => noise.elapsedMs < NOISE_LIFETIME_MS);
    }
  }

  /**
   * Say something.
   *
   * No local echo. The author is on their own level, so the server's copy comes
   * back to them like anyone else's — one code path, and the bubble they see is
   * the bubble everyone else sees, cap and stripping included. Same trade the
   * rest of this class makes: a round trip of latency for never being wrong.
   */
  say(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Sorted here rather than on the server, so a command is never a bubble the
    // world has to take back. @see ../game/commands
    if (isCommand(trimmed)) {
      this.send({ type: "command", text: trimmed.slice(0, MAX_COMMAND_LENGTH) });
      return;
    }
    this.send({ type: "say", text: trimmed.slice(0, MAX_CHAT_LENGTH) });
  }

  getMap(): MapFile {
    return this.map;
  }

  /**
   * Where an actor is, read off the map rather than tracked separately.
   *
   * The map is the authority and it already carries ownership, so there is no
   * second copy of "where everyone is" to drift. `locateActor` confirms the
   * last known cell before it searches, so this stays a lookup per frame.
   */
  private locate(id: string, motion: RemoteMotion): ActorLocation | null {
    const found = locateActor(this.map, id, motion.lastSeen ?? undefined);
    motion.lastSeen = found;
    if (found) {
      this.releaseArrivedWalk(motion, found);
      this.releaseLandedFall(motion, found);
    }
    return found;
  }

  /**
   * End a walk once the map has moved the actor out of the cell it started in.
   *
   * Arrival is both when the walk *must* end and the only signal that it may.
   * The lerp is anchored on `from` — it drags the tile sitting in that stack
   * slot towards the destination — so once the patch commits the step, that slot
   * holds something else and the lerp would be animating the wrong tile.
   *
   * Held indefinitely until then, deliberately: the patch is the only thing
   * that can make the new position true, and if it never comes the actor is not
   * moving anyway. A grace period would just restore the twitch on a slow link.
   */
  private releaseArrivedWalk(motion: RemoteMotion, at: ActorLocation) {
    const from = motion.walk?.from;
    if (!from) return;
    if (at.x !== from.x || at.y !== from.y || at.z !== from.z) {
      motion.walk = null;
    }
  }

  /**
   * End a fall once the map has put the actor down on its landing.
   *
   * A walk is released by the actor leaving the cell it started in, but a
   * landing has no such signal: falling within a level commits without moving
   * the actor's cell at all. Elevation is the thing that actually changed, so
   * that is what is compared — the fall is over when the surface the map has
   * the actor standing on is no higher than the landing it was aimed at.
   *
   * Only ever asked once the client's own animation has reached the landing
   * (`feetAbs === landingAbs`). Mid-fall the map is not a reliable answer: an
   * actor passing through an odd height is placed a unit low, which for a short
   * drop already reads as the landing elevation.
   */
  private releaseLandedFall(motion: RemoteMotion, at: ActorLocation) {
    const fall = motion.fall;
    if (!fall || fall.feetAbs > fall.landingAbs) return;
    const footAbs = standingAbs(this.map, at.x, at.y, at.z, at.stackIndex, this.tilesById);
    if (footAbs <= fall.landingAbs) motion.fall = null;
  }

  private actorSnapshot(id: string, motion: RemoteMotion): ActorSnapshot | null {
    const loc = this.locate(id, motion);
    if (!loc) return null;

    // Absent for anything the server has not reported hit points for, which is
    // every body that is not a battler — the null is what tells the renderer
    // there is no bar to draw.
    const health = this.hps.get(id);

    return {
      id,
      tileId: loc.placed.tileId,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: motion.walk,
      fall: motion.fall,
      walkProgress: motion.walk ? Math.min(1, motion.walk.elapsedMs / motion.walk.durationMs) : 0,
      // Unclamped for the same reason the simulation leaves it unclamped: a
      // fall runs unit after unit, and holding at 1 between them stutters.
      fallProgress: motion.fall ? motion.fall.elapsedMs / FALL_MS_PER_HEIGHT : 0,
      // The live motion by reference, as the simulation hands it over too — the
      // progress beside it is what the renderer lerps with.
      slide: motion.slide,
      slideProgress: motion.slide ? Math.min(1, motion.slide.elapsedMs / PUSH_STEP_MS) : 0,
      strike: motion.strike,
      strikeProgress: motion.strike ? Math.min(1, motion.strike.elapsedMs / STRIKE_DURATION_MS) : 0,
      name: this.names.get(id) ?? null,
      hp: health?.hp ?? null,
      maxHp: health?.maxHp ?? null,
      rating: health?.rating ?? null,
      // The viewer's own list where there is one, because it is the only one
      // with a real countdown on it — which is what lets their own effects wind
      // down smoothly. Everybody else's is rebuilt from the broadcast ids and
      // reads as "not running out". @see applyStatusIds
      statuses: id === this.selfId ? this.statuses : (this.statusesById.get(id) ?? NO_STATUSES),
      // Shared by reference and never mutated in place, exactly as it is on the
      // simulation side: the array the server sent *is* the answer, and copying
      // it per actor per frame would be an allocation for a list that is almost
      // always empty.
      carriedLights: this.carriedLights.get(id) ?? NO_CARRIED_LIGHTS,
      // The viewer's own where there is one, on `statuses`' terms: it is the
      // copy the server addressed to them. Everybody else's is the broadcast.
      extracting: id === this.selfId ? this.extracting : (this.extractionsById.get(id) ?? null),
      // Everybody's off the broadcast, the viewer's own included: a cast has no
      // owner's half. @see castingsById
      casting: this.castingsById.get(id) ?? null,
      // Off the broadcast for everybody including the viewer, on the cast's
      // terms: the switch is the server's state and nothing here predicts it.
      pvp: this.pvpOn.has(id),
    };
  }

  getSnapshot(): GameSnapshot {
    const actors: ActorSnapshot[] = [];
    let self: ActorSnapshot | null = null;
    for (const [id, motion] of this.motions) {
      const snapshot = this.actorSnapshot(id, motion);
      if (!snapshot) continue;
      actors.push(snapshot);
      if (id === this.selfId) self = snapshot;
    }
    if (self) this.lastSelf = self;
    // Before the first hello, or in the gap after a restart, there is nothing to
    // centre on. A placeholder keeps the renderer's contract total rather than
    // making every caller handle a null actor.
    //
    // Once there *has* been a body, the last one is a far better stand-in than
    // the placeholder: being killed removes it from the board, and falling back
    // to the origin would answer a player's death by throwing the camera to the
    // corner of the map. Holding the last known cell leaves them looking at the
    // place it happened, which is the only honest view of a world they are no
    // longer in.
    //
    // Named rather than written inline, because the readings below are about
    // this body too and a second copy of the chain would be the camera and the
    // stats panel describing two different ones.
    const mine = self ?? this.lastSelf ?? offscreenActor(this.selfId);

    return {
      map: this.map,
      self: mine,
      actors,
      targetId: this.targetId,
      attacking: this.attacking,
      equipment: this.equipment,
      tags: this.tags,
      spawnAt: this.spawnAt,
      conversation: this.conversation,
      extracting: this.extracting,
      nextBlow: this.nextBlow,
      masteryXp: this.masteryXp,
      attributes: this.attributesOf(mine),
      // The mark off the broadcast, and whether it may be moved off this side's
      // own status list — the same two answers the simulation gives, from the
      // same two places. @see setPvp
      pvp: { on: mine.pvp, changeable: this.canSetPvp() },
      chats: this.chats,
      noises: this.noises,
      damage: this.damage,
      projectiles: this.projectiles,
      flightEffects: this.flightEffects,
    };
  }

  /**
   * Point at somebody, or at nobody.
   *
   * Held locally so the outline is drawn on the frame the player clicks, and
   * sent so the server knows who to swing at — the same split every other
   * decision here makes, except that this one is not a prediction: nothing is
   * drawn as having happened, so there is nothing to roll back if the server
   * disagrees about whether the target can be reached.
   */
  /**
   * Everything the server has said since the last frame, taken away as it is
   * read. @see PlaySession.drainNotices
   */
  drainNotices(): string[] {
    if (this.pendingNotices.length === 0) return [];
    const said = this.pendingNotices;
    this.pendingNotices = [];
    return said;
  }

  setTarget(actorId: string | null) {
    if (actorId === this.targetId) return;
    this.targetId = actorId;
    this.send({ type: "target", actorId });
  }

  /** Turn the target into a fight, or back into somebody being watched. */
  setAttackMode(enabled: boolean) {
    if (enabled === this.attacking) return;
    this.attacking = enabled;
    this.send({ type: "attackMode", enabled });
  }

  /**
   * Opt into fighting other players, or back out of it. @see `../game/pvp`
   *
   * **Nothing is predicted**, unlike a step and like every other fact about
   * other people: the mark over a head and the state of the button both come
   * off the broadcast, so they cannot show a switch the server did not move.
   * The round trip is a frame or two, and a button that flipped and flipped back
   * would be worse than one that answers a frame late.
   *
   * Asked here before it is sent, on the terms a cast is: a client that offers
   * what the far end refuses is a client whose buttons lie. The server asks the
   * same question again, because this side's answer is as old as its last patch.
   */
  setPvp(enabled: boolean): boolean {
    if (!this.canSetPvp()) return false;
    this.send({ type: "pvp", enabled });
    return true;
  }

  /**
   * Whether the switch may be moved right now — which is to say, whether this
   * body is out of the fight. @see `../game/statuses`' `inCombat`
   *
   * The same test the server runs, over the viewer's own status list, which is
   * the one list on this side with a real countdown on it. Everybody else's is
   * rebuilt from ids and is not asked. @see `../game/GameSession`'s `canSetPvp`
   */
  private canSetPvp(): boolean {
    return !inCombat(this.statuses);
  }

  /**
   * Which stones could be cast right now, answered locally.
   *
   * The same function the server runs — see `../game/casting` — over the same
   * board, the same catalogue, the same kit and the same target. That is what
   * lets a button dim the instant somebody walks out of range instead of a round
   * trip later, and it is why a client can never offer a cast the server will
   * refuse beyond the staleness any shared world has.
   *
   * Nothing is predicted. The cooldown these read comes off the equipment
   * message, which the server sends once a second while anything is cooling, so
   * a countdown here is what the server last said rather than a clock of this
   * side's own — the same arrangement the attack cooldown is under, and the same
   * reason there is no `cast` prediction below.
   */
  spells(): SpellButton[] {
    const context = this.castContext();
    return context ? castableSpells(context) : [];
  }

  /**
   * Cast the stone in this square, if it is one the server would honour.
   *
   * Asked here before it is sent for the reason every other message is: a client
   * that offers what the far end refuses is a client whose buttons lie. It is
   * still asked again over there, because this side is holding a board that may
   * be a round trip old.
   *
   * Nothing changes on this side. The kit comes back on the equipment message
   * with the cooldown on it, which is what dims the button — a predicted
   * cooldown would have to be un-predicted the moment the server disagreed, and
   * a button that flickered back to lit is worse than one that dims a round trip
   * late.
   */
  cast(slot: CastSlot): boolean {
    const context = this.castContext();
    if (!context) return false;

    const verdict = castability(context, slot);
    if (!verdict.ok) {
      // Composed here rather than fetched, and it is the one sentence this side
      // writes for itself. The refusal genuinely happened here — the message was
      // never sent, so the server has nothing to say about it — and the words
      // come from the same file the server's do, so the two cannot drift.
      // @see ../game/notices' castRefusalNotice
      const notice = castRefusalNotice(verdict.reason);
      if (notice) this.pendingNotices.push(notice);
      return false;
    }

    this.send({ type: "cast", slot });
    return true;
  }

  /**
   * Stop the cast this body is making. @see PlaySession.cancelCast
   *
   * Sent only while the broadcast shows this body casting, on the terms `cast`
   * is only sent for a stone this side would honour: a client whose messages
   * mean something is one whose buttons can be trusted. Nothing changes here —
   * the bar and the root lift when the server's next patch says the cast has
   * ended, the same round trip late that every other cast fact arrives.
   */
  cancelCast(): boolean {
    if (!this.castingsById.get(this.selfId)) return false;
    this.send({ type: "cancelCast" });
    return true;
  }

  /**
   * What a cast is decided against on this side, or null while this client does
   * not know where it is standing.
   *
   * Built from exactly the four things the server builds it from, and no more:
   * the board, the kit, what has been learnt, and where the two bodies are. The
   * one difference is where they come from — patches and an equipment message
   * rather than a simulation — which is the whole point of the module being pure.
   */
  /**
   * The spells the body on this tile has of its own.
   *
   * Read out of the tile catalogue exactly as the simulation reads them —
   * authored content both sides hold, on the terms a tile's walking pace is.
   * `resolveBattler` memoises on def identity, so asking per press costs a map
   * lookup.
   */
  private naturalSpells(tileId: string): readonly NaturalSpell[] {
    const def = this.tilesById[tileId];
    return (def ? resolveBattler(def)?.spells : null) ?? NO_SPELLS;
  }

  private castContext(): CastContext | null {
    const motion = this.motions.get(this.selfId);
    if (!motion) return null;
    const from = this.locate(this.selfId, motion);
    if (!from) return null;

    const targetMotion = this.targetId ? this.motions.get(this.targetId) : undefined;
    const to = this.targetId && targetMotion ? this.locate(this.targetId, targetMotion) : null;

    return {
      map: this.map,
      tilesById: this.tilesById,
      equipment: this.equipment,
      // Levels out of the experience the server sends, through the one function
      // that turns one into the other — see `../lib/mastery`. A second reading
      // here would be a second answer to "what level am I".
      masteries: masteriesFromXp(this.masteryXp),
      caster: this.casterPoint(from, motion.walk?.to ?? null),
      // Off the broadcast rather than predicted, on the terms the cooldown is:
      // the cast is the server's clock, and a bar this side started would dim
      // the row for a cast the far end never began. @see castingsById
      casting: this.castingsById.get(this.selfId) ?? null,
      // The body's own spells, read out of the tile catalogue exactly as the
      // simulation reads them — authored content both sides hold, on the terms
      // a tile's walking pace is. Their cooldowns are not broadcast and are
      // wound here, which is what {@link spellCooldownMs} is.
      spells: this.naturalSpells(from.placed.tileId),
      spellCooldownsMs: this.spellCooldowns,
      target: to ? this.castPoint(to) : null,
      // The same rule the server runs, over what this side knows about the two
      // bodies: a player is a body wearing the player tile, which is the test
      // `bodyNameFor` already reads identity off. @see `../game/pvp`
      mayHarmTarget:
        to && this.targetId
          ? mayHarm(this.combatant(this.selfId, from), this.combatant(this.targetId, to))
          : true,
    };
  }

  /**
   * Where this client casts from: where it stands, or the cell its own walk is
   * carrying it into.
   *
   * The same answer `GameSession.casterPointOf` gives, and it is the one the
   * server will reach too: a cast is queued behind every step this client sent
   * before it, so by the time it is honoured the server's body is walking into
   * the same cell this one is. The cell the board still holds is the one being
   * left, and a flame laid in front of *that* is laid where the body is going.
   */
  private casterPoint(from: ActorLocation, walkingTo: Coord | null): CasterPoint {
    const facing = actorDirection(from);
    const tileId = from.placed.tileId;
    if (!walkingTo) return { ...this.castPoint(from), facing, tileId };

    const { x, y, z } = walkingTo;
    const stack = getStack(this.map, x, y, z);
    return {
      x,
      y,
      z,
      stackIndex: stack.length,
      elevAbs: absoluteStandingElevation(z, stack, this.tilesById),
      facing,
      tileId,
    };
  }

  /**
   * Where a body is, in the terms reach and line of sight are measured in.
   *
   * The same arithmetic `GameSession.reachPointOf` does, and it has to be: the
   * elevation is the surface the body is *standing on*, so a rat on a crate is
   * half a level nearer than a rat beside it, and a client measuring from the
   * floor would dim a button the server would have honoured.
   */
  /** One body as the harm rule sees it. @see `../game/pvp`'s `combatantOf` */
  private combatant(id: string, loc: ActorLocation): Combatant {
    return combatantOf({
      id,
      tileId: loc.placed.tileId,
      pvp: this.pvpOn.has(id),
    });
  }

  private castPoint(loc: ActorLocation): CastPoint {
    const stack = getStack(this.map, loc.x, loc.y, loc.z);
    return {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      elevAbs: absoluteStandingElevation(loc.z, stack.slice(0, loc.stackIndex), this.tilesById),
    };
  }

  /**
   * Answered locally, from the same rules the server validates with.
   *
   * Asking the server would put a round trip between the pointer moving and the
   * outline appearing. Because both sides run `../game/affordances` over the
   * same board, a client cannot offer something the server will refuse — beyond
   * the round trip of staleness that any shared world has.
   */
  canInteract(ref: ObjectRef): boolean {
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    // Mid-motion the answer is no, matching the session's own gate.
    if (motion.walk || motion.fall || motion.slide) return false;
    // And no while a step is still unconfirmed, for the same reason one cell
    // further back: the server gates interaction on the actor being idle, and
    // an actor this client has already walked is one the server is still
    // walking. Offering the affordance in that window would have the tap
    // silently refused at the other end.
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    return (
      canRewardFrom(this.map, this.tilesById, loc, ref, this.equipment, this.tags) ||
      // Asked of the body standing here rather than of the player tile, on the
      // same terms `../game/interactionOptions` asks it: whether the far end
      // has room is a question about who is making the trip.
      this.canTeleport(loc, ref) ||
      canSwitchFrom(this.map, this.tilesById, loc, ref) ||
      // No wrapper, unlike the teleport above: a status asks nothing about the
      // body taking it that this side would have to look up. Whether the presser
      // has hit points to lose is the server's question and it is asked there —
      // everything this client can drive is a battler, so a row this offers is
      // one the server will honour.
      canAddStatusFrom(this.map, this.tilesById, loc, ref) ||
      // No wrapper either, on the status's own argument and with less left to
      // ask: the cell this would record is the one the body is already standing
      // in. Whether the presser is somebody who comes back at all is the
      // server's question — everything this client can drive is a player, so a
      // row this offers is one the server will honour.
      canSetSpawnFrom(this.map, this.tilesById, loc, ref) ||
      // The same four questions the server asks — how much is left in it, how
      // much of that somebody else is already holding, whether what comes out
      // would fit, and whether this player is already on it — off the same map,
      // the same pull and the same kit. Being the same function is what stops
      // this offering a pull the far end would refuse.
      canBeginExtract(this.map, this.tilesById, loc, this.equipment, ref, this.extracting) ||
      canEquipFrom(this.map, this.tilesById, loc, ref, this.equipment) ||
      canPickUpFrom(this.map, this.tilesById, loc, ref, this.equipment) ||
      canPushFrom(this.map, this.tilesById, loc, ref)
    );
  }

  /**
   * The one arm of {@link canInteract} that needs to know whose body is making
   * the trip, so it is the one arm with a wrapper.
   *
   * The traveller is read off the map rather than assumed to be the player
   * tile: a ladder's far end has to hold whatever is climbing it, and that is a
   * question about height. `../game/GameSession.canTeleport` asks it the same
   * way, which is what keeps the row this offers one the server will honour.
   *
   * A missing def refuses. The catalogue is the same on both sides, so a tile
   * this client cannot name is one it cannot reason about either.
   */
  private canTeleport(loc: ActorLocation, ref: ObjectRef): boolean {
    const travellerDef = this.tilesById[loc.placed.tileId];
    if (!travellerDef) return false;
    return canTeleportFrom(this.map, this.tilesById, loc, ref, travellerDef);
  }

  interact(ref: ObjectRef): boolean {
    if (!this.canInteract(ref)) return false;
    this.send({ type: "interact", ref });
    // The board does not change here — it changes when the patch lands.
    return true;
  }

  /**
   * Ask for the thing at this slot.
   *
   * Not predicted, unlike a step. A step is drawn immediately because this side
   * can re-run the rule that allows it and be right almost always; a pickup
   * changes what is in a bag, and showing somebody an item they turn out not to
   * have is a worse lie than a moment's delay. Both halves land together when
   * the patch and the equipment message arrive — the cell losing the item and
   * the bag gaining it.
   *
   * The local check is still worth running: it is the same question the server
   * will ask, so a refusal costs no round trip at all.
   */
  pickUp(ref: ObjectRef): boolean {
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    if (!canPickUpFrom(this.map, this.tilesById, loc, ref, this.equipment)) {
      return false;
    }
    this.send({ type: "pickUp", ref });
    return true;
  }

  /**
   * Ask for the thing to be put on rather than put away.
   *
   * Not predicted, on the same terms a pickup is not: it changes what is in a
   * hand, and drawing somebody holding a sword they turn out not to have is a
   * worse lie than a moment's delay. The local check is the server's own, so a
   * refusal costs no round trip.
   */
  equip(ref: ObjectRef): boolean {
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    if (!canEquipFrom(this.map, this.tilesById, loc, ref, this.equipment)) {
      return false;
    }
    this.send({ type: "equip", ref });
    return true;
  }

  /**
   * Ask for the thing to be eaten or drunk.
   *
   * Not predicted, on the same terms as a pickup and more so: it changes hit
   * points as well as what exists, and both are the server's answers. The local
   * check mirrors the server's gates — a pickup's for the floor arm, a move's
   * for the slot arm — so a refusal costs no round trip at all.
   */
  consume(from: ConsumeSource): boolean {
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;

    if (from.kind === "floor") {
      // A board action, gated like a pickup: not mid-motion, and not while a
      // step the server has yet to confirm would put reach in doubt.
      if (motion.walk || motion.fall || motion.slide) return false;
      if (this.pending.length > 0) return false;
      if (!canConsumeFrom(this.map, this.tilesById, loc, from.ref)) return false;
    } else {
      const instance = itemInSlot(this.map, this.tilesById, loc, this.equipment, from.slot);
      const def = instance && this.tilesById[instance.tileId];
      if (!def || !resolveConsumable(def)) return false;
    }

    this.send({ type: "consume", from });
    return true;
  }

  /**
   * Ask for the thing to be spent at whatever turns it into something else.
   *
   * Not predicted, on the same terms a pickup is not: it changes what is in a
   * bag, and drawing somebody holding a cooked steak they turn out not to have
   * is a worse lie than a moment's delay. The local check is the server's own —
   * reach, the recipe existing, having the input, and room for what comes
   * back — so a refusal costs no round trip at all.
   *
   * Gated like a board action rather than like a move, matching the session:
   * you reach out and do this to something in the world, and an actor whose
   * last step the server has yet to confirm is not standing beside it yet.
   */
  /**
   * Open, press, go back, or close — sent, and answered by the `conversation`
   * message that follows. Only the open is checked here, on the terms a
   * transmute is: reach is a thing the client can see, and a press on a
   * button the server no longer offers is a race it will simply not answer.
   */
  talk(action: TalkAction): boolean {
    if (action.kind === "open") {
      const motion = this.motions.get(this.selfId);
      const loc = motion && this.locate(this.selfId, motion);
      if (!loc) return false;
      if (!canTalkFrom(this.map, this.tilesById, loc, action.ref)) return false;
    } else if (!this.conversation) {
      return false;
    }
    this.send({ type: "talk", action });
    return true;
  }

  transmute(ref: ObjectRef, recipe: number): boolean {
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    if (!canTransmuteFrom(this.map, this.tilesById, loc, this.equipment, ref, recipe)) {
      return false;
    }

    this.send({ type: "transmute", ref, recipe });
    return true;
  }

  /**
   * Would this move land, as far as this side can tell?
   *
   * Answered locally so a drag can light its target the instant the pointer is
   * over it, on exactly the terms {@link canInteract} is: the rules are shared,
   * so an interface built on this cannot offer a move the server will refuse.
   *
   * Deliberately without the idle and unconfirmed-step gates a pickup carries.
   * Those exist because the server refuses a board action from an actor
   * mid-motion; a move is not a board action, so a client that hid the slots
   * while somebody was walking would be inventing a rule the other end does not
   * have.
   */
  canMoveItem(from: SlotRef, to: SlotRef): boolean {
    const motion = this.motions.get(this.selfId);
    const loc = motion && this.locate(this.selfId, motion);
    if (!loc) return false;
    return canMoveItem(this.map, this.tilesById, loc, this.equipment, from, to);
  }

  /**
   * Ask for a thing to be moved from one slot to another.
   *
   * Not predicted, for the same reason a pickup is not: what somebody is
   * carrying is the server's answer, and a bag that rearranged itself locally
   * and then snapped back would be a worse thing to watch than one that took a
   * round trip to change. The equipment message is the confirmation, and for a
   * ground container the cell patch beside it.
   */
  moveItem(from: SlotRef, to: SlotRef): boolean {
    if (!this.canMoveItem(from, to)) return false;
    this.send({ type: "moveItem", from, to });
    return true;
  }

  /**
   * Would this land there, as far as this side can tell?
   *
   * Asked once per pointer move while a drag is over the world, which is why it
   * has to be answered here rather than across the wire: a ghost that arrived a
   * round trip after the cursor would be drawing where the pointer *was*.
   */
  canDrop(from: SlotRef, to: Coord): boolean {
    const motion = this.motions.get(this.selfId);
    const loc = motion && this.locate(this.selfId, motion);
    if (!loc) return false;
    const instance = itemInSlot(this.map, this.tilesById, loc, this.equipment, from);
    const def = instance && this.tilesById[instance.tileId];
    if (!def) return false;
    return canDropAt(this.map, this.tilesById, loc, to, def);
  }

  /**
   * Ask for a thing to be put down.
   *
   * Not predicted, on the same terms as every other item action: the board is
   * the server's, and a sword drawn onto the floor that turned out not to be
   * there is a worse thing to watch than a moment's delay. The cell patch is the
   * confirmation, and the equipment message beside it.
   */
  drop(from: SlotRef, to: Coord): boolean {
    if (!this.canDrop(from, to)) return false;
    this.send({ type: "drop", from, to });
    return true;
  }

  /**
   * Take what the player is holding. Nothing is sent from here.
   *
   * Held directions used to *be* the message, and the server decided what they
   * meant. Now they are kept and acted on locally, and only the steps they
   * produce travel — so the wire carries one small frame per cell walked instead
   * of one per key event, and the first one goes out with the step already
   * drawn.
   *
   * Stepping immediately rather than waiting for the next frame: 16ms is small
   * next to the round trip just removed, but it is the first 16ms of the press
   * and it is free to not spend.
   */
  setInput(input: GameInput) {
    // A dead session holds nothing and predicts nothing. The keyboard is still
    // bound — it listens on the window, which the death screen does not cover —
    // so this is where a key held through a death stops meaning anything, and
    // where a key pressed at the screen stops being a step waiting to be taken
    // the moment a body exists again.
    if (this.dead) return;
    this.held = {
      directions: [...input.directions],
      faceOnly: input.faceOnly,
      preferDescend: input.preferDescend,
    };
    this.predictStep();
  }

  private send(message: ClientMessage) {
    this.sendRaw(JSON.stringify(message));
  }

  private sendRaw(payload: string) {
    if (this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(payload);
  }
}

/**
 * The empty list every actor without a lantern shares.
 *
 * One object rather than a fresh `[]` per actor per frame. It is never written
 * to — carried lights arrive whole from the server and replace the entry — so
 * sharing it is safe in the way sharing a mutable default never is.
 */
const NO_CARRIED_LIGHTS: string[] = [];

/**
 * What a client holds before the server has said otherwise, and for anybody who
 * has taken no reward. Shared on the same terms {@link NO_CARRIED_LIGHTS} is:
 * tags arrive whole and replace the array rather than being appended to.
 */
const NO_TAGS: readonly string[] = [];

/** The same emptiness for the waits, and shared for the same reason. */

/** Shared empty list, since no remote body ever carries statuses. */
const NO_STATUSES: readonly StatusInstance[] = [];

/** Shared empty list, on those terms: almost no body has spells of its own. */
const NO_SPELLS: readonly NaturalSpell[] = [];

/**
 * Shared empty list for the overwhelmingly common patch: one where every body
 * that moved is still standing somewhere. Allocating per frame for the answer
 * "nobody died" would be a garbage collection on the render path.
 */
const NO_OWNERS: readonly string[] = [];

function emptyMotion(): RemoteMotion {
  return { walk: null, fall: null, slide: null, strike: null, lastSeen: null };
}

/** Stand-in for an actor not on the board yet. Drawn nowhere, centres nothing. */
function offscreenActor(id: string): ActorSnapshot {
  return {
    id,
    // Nameless, because nothing draws this body: it exists to keep the
    // renderer's contract total before the first `hello` and after a death,
    // and neither of those is a moment anybody is reading a label.
    name: null,
    // The viewer's own body, which is always a player's — this stands in for
    // one that has not arrived yet, not for one that turned out to be a deer.
    tileId: PLAYER_TILE_ID,
    x: 0,
    y: 0,
    z: 0,
    stackIndex: 0,
    direction: "s",
    walk: null,
    fall: null,
    walkProgress: 0,
    fallProgress: 0,
    slide: null,
    slideProgress: 0,
    strike: null,
    strikeProgress: 0,
    hp: null,
    maxHp: null,
    rating: null,
    statuses: NO_STATUSES,
    carriedLights: NO_CARRIED_LIGHTS,
    extracting: null,
    casting: null,
    // Unmarked, like everything else here: a body that has not arrived is not
    // in anybody's fight.
    pvp: false,
  };
}
