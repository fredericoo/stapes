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
  UNKNOWN_REMAINING_MS,
  type StatusInstance,
} from "../game/statuses";
import type { ProjectileFlight } from "../game/projectile";
import type { StrikeState } from "../game/strike";
import {
  actorDirection,
  actorStillAt,
  locateActor,
  type ActorLocation,
} from "../game/actors";
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
  canTeleportFrom,
  type ObjectRef,
} from "../game/affordances";
import { canWorkNow, type ExtractCooling } from "../game/extract";
import { type Equipment, emptyEquipment } from "../game/equipment";
import {
  castability,
  castableStones,
  type CastContext,
  type CastPoint,
  type CastSquare,
  type SpellButton,
} from "../game/casting";
import { masteriesFromXp, type MasteryXp } from "../lib/mastery";
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
import { resolveWalkDurationMs, standingAbs } from "../game/movement";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import {
  absoluteStandingElevation,
  chunkifyMap,
  emptyMap,
  getStack,
  isPlayerBody,
  setStacks,
} from "../lib/mapData";
import type {
  Coord,
  Direction,
  FlatMapFile,
  MapFile,
  TileDef,
} from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  CHAT_LIFETIME_MS,
  MAX_CHAT_LENGTH,
  MAX_CHATS_PER_CELL,
} from "./chat";
import { MAX_COMMAND_LENGTH, isCommand } from "../game/commands";
import {
  parseServerMessage,
  type CellPatch,
  type ClientMessage,
  type CarriedLightsPatch,
  type StatusIdsPatch,
  type HpPatch,
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
  /** Last place this actor was found, so relocating them stays a cell lookup. */
  lastSeen: ActorLocation | null;
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
  /** Time since it was sent, for {@link STEP_CONFIRM_TIMEOUT_MS}. */
  waitedMs: number;
};

/**
 * How far ahead of the server this client will walk before it waits.
 *
 * A step is confirmed a round trip *plus* a walk after it was sent, so several
 * are legitimately outstanding at once on exactly the slow link this prediction
 * exists for — a tight cap here would reinstate the stall it is meant to
 * remove. Eight covers a round trip well past a second. Past that something is
 * wrong rather than slow, and {@link STEP_CONFIRM_TIMEOUT_MS} is what notices.
 */
const MAX_PREDICTED_STEPS = 8;

/**
 * How long the oldest unconfirmed step waits before this client gives up on it.
 *
 * The backstop, not the mechanism: a refused step normally comes back as its own
 * message and is rolled back at once. This catches only the cases where no
 * answer arrives at all, and sits well past the round trip a confirmation takes
 * so an ordinary slow link never trips it.
 */
export const STEP_CONFIRM_TIMEOUT_MS = 2_000;

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
  private readonly hps = new Map<
    string,
    { hp: number; maxHp: number; rating: number }
  >();
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
   * What this viewer is carrying, as the server last said.
   *
   * Never predicted, unlike a step. A step is drawn immediately because the
   * client can re-run the rule that allows it and be right almost always; what
   * ends up in a bag depends on what else is in it and on a board the server
   * owns, and a wrong guess would show somebody an item they do not have.
   */
  private equipment: Equipment = emptyEquipment();
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
   * Where the viewer is in a conversation, as the server last said. Whole
   * state like the kit and the tags beside it; null is the panel closed.
   */
  private conversation: Conversation | null = null;
  /**
   * Which resources this player may not work just yet, as the server last said
   * — see `../game/extract`'s `extractKey`.
   *
   * Never predicted, on the terms the kit and the tags are not: the wait is the
   * server's clock, and a client guessing when it ran out would offer a row that
   * is about to be refused. Replaced wholesale, so its identity is what tells
   * the renderer to rebuild its rows.
   */
  private extractCooling: readonly ExtractCooling[] = NO_COOLING;
  /**
   * {@link extractCooling} as something the rules can ask, rebuilt beside it.
   *
   * Derived and cached rather than built where it is read, on exactly the
   * grounds the server caches the list beside its map: `canInteract` is asked
   * per candidate cell on every pointer move, and building a map per call would
   * be an allocation per cell per frame for a list that changes twice a pull.
   *
   * Holds **the same entries** the list does, so {@link update} winding one
   * advances both.
   */
  private coolingByKey = new Map<string, ExtractCooling>();
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
  /** How many people the server last said were here. */
  private players = 0;
  private onPlayers: ((count: number) => void) | null = null;

  constructor(
    private readonly socket: WebSocket,
    tiles: TileDef[],
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
   * The world's time of day as of the last `hello`.
   *
   * Read once, when the renderer starts: from there the renderer runs the same
   * rate the server does, so a single anchor is enough to keep two browsers in
   * the same hour without a clock on the wire every tick.
   */
  minutesOfDay(): MinutesOfDay {
    return this.serverMinutesOfDay;
  }

  dispose() {
    this.socket.removeEventListener("message", this.onMessage);
  }

  private onMessage = (event: MessageEvent) => {
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
      // Nothing to do here — the close that follows carries the code the page
      // acts on. Consumed so it does not fall through to a warning about a
      // message this side does not know.
      return;
    }

    if (message.type === "hello") {
      this.selfId = message.selfId;
      this.serverMinutesOfDay = message.minutesOfDay;
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
      // exists, on the same terms the bubbles above are.
      this.projectiles = [];
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
      // Replaced outright rather than kept: the body at the other end is a
      // fresh one, and what it is carrying is whatever the server just said —
      // not what the body in the previous world had on it.
      this.equipment = message.equipment;
      // Same rule, and it matters more here: a fresh body in a replaced world
      // still belongs to the same person, and dropping their tags would hand
      // them every reward in the map a second time.
      this.tags = message.tags;
      // Same rule a third time. The world may have been replaced under them,
      // but the wait they owe that bush is a fact about the last few seconds and
      // the server is still counting it.
      this.setExtractCooling(message.extractCooling);
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
      this.applyHps(message.hps);
      this.applyCarriedLights(message.carriedLights);
      this.applyStatusIds(message.statusIds);
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

    if (message.type === "conversation") {
      // Whole state, like the kit and the tags: null closes the panel, whether
      // the viewer pressed Close or walked out of reach.
      this.conversation = message.conversation;
      return;
    }

    if (message.type === "extractCooling") {
      // Whole state, like everything else addressed to one socket here.
      this.setExtractCooling(message.cooling);
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
    this.applyHps(message.hps);
    this.applyCarriedLights(message.carriedLights);
    this.applyStatusIds(message.statusIds);
    for (const event of message.events) this.applyEvent(event);
    this.forgetDeparted(leaving);
    this.rebuildPredicted();
  };

  /**
   * Hold the cooling list and the set built from it, together.
   *
   * The one place either is written, on the terms the server's own
   * `setExtractCooldowns` is: the list is what the snapshot carries and the set
   * is what the rules ask, and one moving without the other would be a row
   * offered on a resource the far end knows is still cooling.
   */
  private setExtractCooling(cooling: readonly ExtractCooling[]) {
    // Copied entry by entry rather than adopted, because {@link update} winds
    // these in place: the parsed message is this client's to spend, and holding
    // the validator's own objects would be mutating something nothing else
    // expects to move.
    this.extractCooling = cooling.map((entry) => ({ ...entry }));
    this.coolingByKey = new Map(
      this.extractCooling.map((entry) => [entry.key, entry]),
    );
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
   * How fast whatever is standing at `at` walks.
   *
   * Taken from the top of the stack, which is where a body sits. A cell that
   * has already been patched out from under the event falls back to the
   * player's pace — the wrong answer for one step of one creature, and better
   * than refusing to animate it.
   */
  private walkDurationAt(at: { x: number; y: number; z: number }): number {
    const stack = getStack(this.map, at.x, at.y, at.z);
    const def = this.tilesById[stack[stack.length - 1]?.tileId ?? ""];
    return def ? resolveWalkDurationMs(def) : WALK_DURATION_MS;
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
      this.projectiles.push({
        id: event.id,
        tileId: event.tileId,
        from: event.from,
        to: event.to,
        durationMs: event.durationMs,
        elapsedMs: 0,
      });
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
      // slowly is planted for one of *their* steps — the same reading the
      // simulation takes. @see `../game/movement`
      this.attackRecoveryMs = def
        ? resolveWalkDurationMs(def)
        : WALK_DURATION_MS;
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
        durationMs: this.walkDurationAt(event.from),
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
    this.windExtractCooling(dtMs);
    this.agePendingSteps(dtMs);
    this.advancePrediction();
    this.expireChats(dtMs);
    this.expireNoises(dtMs);
    this.expireDamage(dtMs);
    this.expireProjectiles(dtMs);
  }

  /**
   * Wind the resource waits down against the render clock.
   *
   * **Local, and not a prediction of anything.** The server is still the only
   * thing that decides when a wait is over — its "it is over" message is what
   * clears the entry, and nothing here ever removes one. What this keeps true is
   * the *number*, which the bar under a greyed row is a fraction of: the wire
   * carries a wait twice, at its start and at its end, so between those two the
   * client is the only thing that knows any time has passed.
   *
   * Floored rather than allowed negative, and the entry is kept at zero: a bar
   * that has run out reads as "any moment now", which is exactly true — the
   * message clearing it is at most a tick away.
   *
   * Wound in place, so the list handed to the snapshot keeps its identity and
   * the interaction rows are not rebuilt thirty times a second. The same
   * hand-over the motions above travel on.
   */
  private windExtractCooling(dtMs: number) {
    for (const entry of this.extractCooling) {
      if (entry.remainingMs <= 0) continue;
      entry.remainingMs = Math.max(0, entry.remainingMs - dtMs);
    }
  }

  /**
   * Land the arrows that have arrived.
   *
   * Timed off the render loop's delta exactly as the numbers above are — and,
   * exactly as they are, dropped with nothing to commit: there was never
   * anything for the arrow to do on arrival, since the blow it depicts was
   * settled on the tick it was loosed. @see `../game/projectile`
   *
   * Each flight carries its own duration rather than sharing a constant, unlike
   * every other motion here: how long a shot takes depends on how far it went.
   */
  private expireProjectiles(dtMs: number) {
    if (this.projectiles.length === 0) return;
    let arrived = false;
    for (const flight of this.projectiles) {
      flight.elapsedMs += dtMs;
      if (flight.elapsedMs >= flight.durationMs) arrived = true;
    }
    if (arrived) {
      this.projectiles = this.projectiles.filter(
        (flight) => flight.elapsedMs < flight.durationMs,
      );
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
      this.damage = this.damage.filter(
        (number) => number.elapsedMs < DAMAGE_NUMBER_LIFETIME_MS,
      );
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
    if (oldest.waitedMs >= STEP_CONFIRM_TIMEOUT_MS) this.abandonPrediction();
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
    motion.lastSeen = {
      ...step.to,
      stackIndex: stack.length - 1,
      placed: stack[stack.length - 1]!,
    };
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

    const choice = chooseStep(
      this.map,
      loc,
      this.held,
      def,
      this.tilesById,
      (to) => this.destinationTaken(to),
    );
    if (!choice) return;

    this.face(loc, choice.facing);
    if (!choice.step) return;
    // After the turn, exactly as the simulation gates it after the turn: a blow
    // costs the step and not the aim. @see `../game/GameSession`
    if (this.attackRecoveryMs > 0) return;

    const seq = this.nextStepSeq++;
    motion.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs,
      // Our own body, so its pace is the one the server will time us by.
      durationMs: resolveWalkDurationMs(def),
    };
    this.pending.push({
      seq,
      to: choice.step.to,
      direction: choice.step.direction,
      landed: false,
      waitedMs: 0,
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
    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      direction,
    );
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
    const at = locateActor(
      this.serverMap,
      this.selfId,
      this.serverSeen ?? undefined,
    );
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
      map = setEntityDirection(
        map,
        loc.x,
        loc.y,
        loc.z,
        loc.stackIndex,
        this.facing,
      );
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
    const here = this.chats.filter(
      (chat) => chat.x === at.x && chat.y === at.y && chat.z === at.z,
    );
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
      this.chats = this.chats.filter(
        (chat) => chat.elapsedMs < CHAT_LIFETIME_MS,
      );
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
      this.noises = this.noises.filter(
        (noise) => noise.elapsedMs < NOISE_LIFETIME_MS,
      );
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
    const footAbs = standingAbs(
      this.map,
      at.x,
      at.y,
      at.z,
      at.stackIndex,
      this.tilesById,
    );
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
      walkProgress: motion.walk
        ? Math.min(1, motion.walk.elapsedMs / motion.walk.durationMs)
        : 0,
      // Unclamped for the same reason the simulation leaves it unclamped: a
      // fall runs unit after unit, and holding at 1 between them stutters.
      fallProgress: motion.fall
        ? motion.fall.elapsedMs / FALL_MS_PER_HEIGHT
        : 0,
      // The live motion by reference, as the simulation hands it over too — the
      // progress beside it is what the renderer lerps with.
      slide: motion.slide,
      slideProgress: motion.slide
        ? Math.min(1, motion.slide.elapsedMs / PUSH_STEP_MS)
        : 0,
      strike: motion.strike,
      strikeProgress: motion.strike
        ? Math.min(1, motion.strike.elapsedMs / STRIKE_DURATION_MS)
        : 0,
      hp: health?.hp ?? null,
      maxHp: health?.maxHp ?? null,
      rating: health?.rating ?? null,
      // The viewer's own list where there is one, because it is the only one
      // with a real countdown on it — which is what lets their own effects wind
      // down smoothly. Everybody else's is rebuilt from the broadcast ids and
      // reads as "not running out". @see applyStatusIds
      statuses:
        id === this.selfId
          ? this.statuses
          : (this.statusesById.get(id) ?? NO_STATUSES),
      // Shared by reference and never mutated in place, exactly as it is on the
      // simulation side: the array the server sent *is* the answer, and copying
      // it per actor per frame would be an allocation for a list that is almost
      // always empty.
      carriedLights: this.carriedLights.get(id) ?? NO_CARRIED_LIGHTS,
    };
  }

  getSnapshot(): GameSnapshot {
    const actors: ActorSnapshot[] = [];
    let self: ActorSnapshot | null = null;
    /**
     * Bodies the board no longer has, forgotten after the walk rather than
     * during it.
     *
     * A miss costs a search of the whole board (`locateActor`), and paying that
     * once is the price of noticing somebody has gone. Paying it *every frame*
     * for the same body is what happens if the entry is left behind — which is
     * what a client scoped to part of the map is full of, since a creature
     * walking out of view leaves the board without dying. Measured at 108ms of
     * a 116ms frame before this. @see `../net/interest`
     */
    let gone: string[] | null = null;
    for (const [id, motion] of this.motions) {
      const snapshot = this.actorSnapshot(id, motion);
      if (!snapshot) {
        // Never this client's own body: a death takes it off the board and it
        // has to be here to come back to. @see dead
        if (id !== this.selfId) (gone ??= []).push(id);
        continue;
      }
      actors.push(snapshot);
      if (id === this.selfId) self = snapshot;
    }
    if (gone) for (const id of gone) this.forgetActor(id);
    if (self) this.lastSelf = self;

    return {
      map: this.map,
      // Before the first hello, or in the gap after a restart, there is nothing
      // to centre on. A placeholder keeps the renderer's contract total rather
      // than making every caller handle a null actor.
      //
      // Once there *has* been a body, the last one is a far better stand-in than
      // the placeholder: being killed removes it from the board, and falling
      // back to the origin would answer a player's death by throwing the camera
      // to the corner of the map. Holding the last known cell leaves them
      // looking at the place it happened, which is the only honest view of a
      // world they are no longer in.
      self: self ?? this.lastSelf ?? offscreenActor(this.selfId),
      actors,
      targetId: this.targetId,
      attacking: this.attacking,
      equipment: this.equipment,
      tags: this.tags,
      conversation: this.conversation,
      extractCooling: this.extractCooling,
      masteryXp: this.masteryXp,
      chats: this.chats,
      noises: this.noises,
      damage: this.damage,
      projectiles: this.projectiles,
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
    return context ? castableStones(context) : [];
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
  cast(square: CastSquare): boolean {
    const context = this.castContext();
    if (!context || !castability(context, square).ok) return false;
    this.send({ type: "cast", square });
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
  private castContext(): CastContext | null {
    const motion = this.motions.get(this.selfId);
    if (!motion) return null;
    const from = this.locate(this.selfId, motion);
    if (!from) return null;

    const targetMotion = this.targetId
      ? this.motions.get(this.targetId)
      : undefined;
    const to =
      this.targetId && targetMotion
        ? this.locate(this.targetId, targetMotion)
        : null;

    return {
      map: this.map,
      tilesById: this.tilesById,
      equipment: this.equipment,
      // Levels out of the experience the server sends, through the one function
      // that turns one into the other — see `../lib/mastery`. A second reading
      // here would be a second answer to "what level am I".
      masteries: masteriesFromXp(this.masteryXp),
      caster: this.castPoint(from),
      target: to ? this.castPoint(to) : null,
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
  private castPoint(loc: ActorLocation): CastPoint {
    const stack = getStack(this.map, loc.x, loc.y, loc.z);
    return {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      elevAbs: absoluteStandingElevation(
        loc.z,
        stack.slice(0, loc.stackIndex),
        this.tilesById,
      ),
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
      canRewardFrom(
        this.map,
        this.tilesById,
        loc,
        ref,
        this.equipment,
        this.tags,
      ) ||
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
      // The same three questions the server asks — how much is left in it,
      // whether this player is still waiting on it, and whether what comes out
      // would fit — off the same map, the same cooling list and the same kit.
      // Being the same function is what stops this offering a pull the far end
      // would refuse.
      canWorkNow(
        this.map,
        this.tilesById,
        loc,
        this.equipment,
        ref,
        this.coolingByKey,
      ) ||
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
      const instance = itemInSlot(
        this.map,
        this.tilesById,
        loc,
        this.equipment,
        from.slot,
      );
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
    if (
      !canTransmuteFrom(
        this.map,
        this.tilesById,
        loc,
        this.equipment,
        ref,
        recipe,
      )
    ) {
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
    return canMoveItem(
      this.map,
      this.tilesById,
      loc,
      this.equipment,
      from,
      to,
    );
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
    const instance = itemInSlot(
      this.map,
      this.tilesById,
      loc,
      this.equipment,
      from,
    );
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
    if (this.socket.readyState !== WebSocket.OPEN) return;
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
const NO_COOLING: readonly ExtractCooling[] = [];

/** Shared empty list, since no remote body ever carries statuses. */
const NO_STATUSES: readonly StatusInstance[] = [];

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
  };
}
