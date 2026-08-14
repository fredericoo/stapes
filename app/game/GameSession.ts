import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isWalkableSurfaceAt,
  removeTileAt,
  replaceStack,
} from "../lib/mapData";
import { resolveSwitch } from "../lib/interactions";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { MIN_LEVEL } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  actorDirection,
  adoptAuthoredPlayer,
  adoptBodyAt,
  listResidentBodies,
  residentOwnerId,
  despawnActor,
  findActorAnywhere,
  listActorOwners,
  locateActor,
  removeAuthoredPlayer,
  spawnActor,
  spawnPoint,
  type ActorLocation,
} from "./actors";
import {
  canPickUpFrom,
  canPushFrom,
  canSwitchFrom,
  pickUpDestination,
  interactiveDefAt,
  pushDirectionFrom,
  pushTargetFrom,
  type ObjectRef,
} from "./affordances";
import { findEntryCell } from "./entry";
import {
  BRAIN_TICK_MS,
  DAMAGE_NUMBER_LIFETIME_MS,
  FALL_MS_PER_HEIGHT,
  MAX_CLIMB_HEIGHT,
  PUSH_STEP_MS,
  STARTING_BAG_TILE_ID,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
import { resolveBattler, type BattlerDef } from "../lib/battler";
import { attackIntervalMs, inAttackRange, rollAttack } from "./combat";
import type { Equipment } from "./equipment";
import {
  effectiveBattler,
  emptyEquipment,
  startingEquipment,
} from "./equipment";
import { mintItemIds } from "./itemIds";
import { applyItemMove, canMoveItem, type SlotRef } from "./itemMoves";
import { instanceFromPlacement } from "../lib/itemInstance";
import {
  cellForFeetAbs,
  cellHasLooseGravity,
  findLandingAbs,
  findLooseGravityCells,
  findWalkableLandingAbs,
  isSupported,
  settleGravity,
} from "./gravity";
import {
  moveEntity,
  placeEntityOnSurface,
  removeEntity,
  setEntityDirection,
} from "./mapMutations";
import {
  canWalk,
  DIR_DELTA,
  listStandingSurfaces,
  resolveWalkDurationMs,
  standingAbs,
} from "./movement";
import { resolveBrain } from "../lib/brain";
import {
  initialMemory,
  stepBrain,
  type BrainMemory,
  type Utterance,
} from "./brainRuntime";
import { hasLineOfSight } from "./sight";
import { Rng } from "./rng";
import { chooseStep, type StepRequest } from "./stepping";
import {
  cellHasPlate,
  cellKey,
  findPlateCells,
  settlePlates,
} from "./pressurePlates";
import {
  cellIsWired,
  findWiredCells,
  settleSignals,
  type ExtraEmitter,
} from "./signals";
import { sanitizeChatText } from "../net/chat";

export type { ObjectRef } from "./affordances";

export type WalkState = {
  from: Coord;
  to: Coord;
  direction: Direction;
  elapsedMs: number;
  /**
   * How long this particular step takes — the walker's own pace, not a shared
   * constant. Carried on the motion rather than looked up while it runs, so a
   * step keeps the speed it began at even if the body under it is swapped.
   */
  durationMs: number;
};

export type FallState = {
  feetAbs: number;
  landingAbs: number;
  elapsedMs: number;
};

export type GameInput = {
  /** Held movement directions; latest pressed wins when several are held. */
  directions: Direction[];
  /** Shift: update facing only, do not walk. */
  faceOnly?: boolean;
  /** Option/Alt: prefer lowest surface in climb band. */
  preferDescend?: boolean;
};

/**
 * A pushed object whose sprite is still catching up to where it already is.
 *
 * Deliberately without its progress, which travels beside it as
 * {@link ActorSnapshot.slideProgress}. A snapshot carrying its own progress has
 * to be a fresh object every tick, and the game server announces motion by
 * *identity* — so a rebuilt one reads as a brand new slide every tick, and the
 * client restarts its lerp on each of the six announcements one push produced.
 * Walking and falling hand over their live state for exactly this reason; this
 * is the same discipline, learned late.
 */
export type SlideSnapshot = {
  /** The object at its committed cell — the move is already in the map. */
  object: ObjectRef;
  from: Coord;
};

/**
 * Where an actor is, small enough to keep.
 *
 * Deliberately not an {@link ActorSnapshot}: this is what survives a
 * disconnection, so it holds only what is still true when nobody is driving —
 * a cell and a facing, no motion and no stack index. The index would be a lie
 * the moment anything else is placed in that cell.
 */
export type ActorPosition = Coord & { direction: Direction };

/** One actor as a viewer sees it. */
export type ActorSnapshot = {
  id: string;
  /**
   * The tile this actor's body is. Carried because an actor is no longer
   * necessarily a person: chrome meant for players — a name over the head,
   * above all — has to be able to tell a visitor from a deer, and the body is
   * the honest way to ask.
   */
  tileId: string;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
  direction: Direction;
  walk: WalkState | null;
  fall: FallState | null;
  walkProgress: number;
  fallProgress: number;
  slide: SlideSnapshot | null;
  slideProgress: number;
  /**
   * Hit points right now, or null for a body with none — a crate, a sign, a
   * creature nobody has given stats to.
   *
   * Null rather than zero for "not a battler", because zero is a real and very
   * different answer: it means dead, and a body that hits zero is off the board
   * on the same tick. Anything drawing a health bar keys off the null.
   */
  hp: number | null;
  /** What {@link hp} is measured against; null exactly when `hp` is. */
  maxHp: number | null;
};

/**
 * A number floating off somebody who was just hit.
 *
 * Kept alive with its own clock rather than fired and forgotten, for the same
 * reason a chat bubble is: it has to outlive the tick that produced it, and
 * often outlives the body it came off — a killing blow deletes its target
 * immediately, and the number is the only thing left saying what happened.
 *
 * Which is why the cell travels rather than the actor id alone. By the time this
 * is drawn there may be nobody by that name to ask where they were standing.
 */
export type DamageNumber = {
  /** Distinct per blow, so two hits on one tick are two numbers. */
  id: string;
  /** Who took it. Compared against the viewer's own id to colour the number. */
  targetId: string;
  amount: number;
  x: number;
  y: number;
  z: number;
  /** Where the target stood in that cell's stack, so the number starts at them. */
  stackIndex: number;
  elapsedMs: number;
};

/**
 * Something somebody said, and where it is hanging.
 *
 * Pinned to a cell rather than to its author: the coordinate is the one it was
 * said in, and it stays there while the speaker walks away or disconnects.
 */
export type ChatBubble = {
  /** Distinct per message, so two lines from one actor are two bubbles. */
  id: string;
  actorId: string;
  /**
   * The body the speaker was in when they said it, which is what decides how
   * they are named: a person by the handle derived from their id, a creature by
   * what its tile is called.
   *
   * Carried on the bubble rather than looked up when it is drawn, because the
   * bubble outlives its author — the deer that yelped can wander off, and the
   * editor can replace the map underneath it, and the words are still hanging
   * there for the rest of their five seconds.
   */
  tileId: string;
  text: string;
  x: number;
  y: number;
  z: number;
  /**
   * Where the speaker stood in that cell's stack. Carried so the bubble can
   * hang over the ground *beneath* them rather than over their own head.
   */
  stackIndex: number;
};

export type GameSnapshot = {
  map: MapFile;
  /**
   * The viewer's own actor. Camera, roof-cut and hover follow this one and only
   * this one — they are affordances for whoever is looking, not properties of
   * the board.
   */
  self: ActorSnapshot;
  /** Every actor on the board, self included, in stable id order. */
  actors: ActorSnapshot[];
  /** Object under the viewer's pointer that they can act on right now. */
  hover: ObjectRef | null;
  /**
   * Who the viewer has picked a fight with, or null.
   *
   * The viewer's own, like {@link hover} and for the same reason: a target is
   * an affordance for whoever is looking, not a property of the board. It is
   * what the auto-attack swings at *while {@link attacking}*, and it survives
   * until they clear it, walk out of sight of it, or it dies.
   */
  targetId: string | null;
  /**
   * Whether the viewer is in attack mode — see {@link ActorRuntime.attacking}.
   *
   * Read off the session rather than held by the page that flips it, because the
   * outline colour in the world and the state of the button are two readings of
   * one fact, and a fight that carried on after the button said otherwise would
   * be the client and the server disagreeing about something the player can see.
   */
  attacking: boolean;
  /**
   * Damage still floating, oldest first.
   *
   * Present in every session, unlike {@link chats}: a blow landing is something
   * the local simulation very much does have to say, and `/play` shows numbers
   * exactly as the online client does.
   */
  damage: DamageNumber[];
  /**
   * What the viewer is carrying.
   *
   * The viewer's own, like {@link hover} and {@link targetId}, and for a
   * stronger reason than either: nobody else's inventory is drawn. There is no
   * paperdoll — a sword changes no sprite — so broadcasting everyone's kit to
   * everyone would be paying fan-out for something no frame can show.
   *
   * The day a carried torch lights the room, that is *not* what changes this:
   * light needs a per-actor projection of the equipment
   * (`carriedLightTileIds`), not the equipment itself.
   */
  equipment: Equipment;
  /**
   * Speech still on screen, on this viewer's level only.
   *
   * Always present rather than optional so the renderer's contract stays total;
   * the local simulation has nobody to talk to and returns an empty list.
   */
  chats: ChatBubble[];
};

/** The id the single local actor takes when nobody names one. */
export const LOCAL_ACTOR_ID = "local";

/**
 * Shared empty list for the overwhelmingly common "nobody hit me" answer, so
 * asking costs a map lookup rather than an allocation per creature per tick.
 */
const EMPTY_ATTACKERS: readonly string[] = [];

/**
 * Which way to turn to face a neighbouring cell.
 *
 * The dominant axis wins, so a diagonal foe is faced along whichever side of the
 * square is longer — and a tie, which is every true diagonal, resolves
 * north/south. Null only when the two are in the same cell, which nothing solid
 * can be.
 */
function facingToward(from: Coord, to: Coord): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

/**
 * What the renderer needs from whatever is driving it.
 *
 * {@link GameSession} implements this by simulating locally; the online client
 * implements it by applying patches from the server and interpolating between
 * them. The renderer draws a snapshot and reports a pointer either way — it has
 * no stake in where the truth came from, which is the whole reason this is an
 * interface rather than a concrete class.
 *
 * The methods without an actor argument are the viewer's own: there is exactly
 * one pointer and one camera per client.
 */
export interface PlaySession {
  update(dtMs: number): void;
  getSnapshot(): GameSnapshot;
  getMap(): MapFile;
  setHoveredObject(ref: ObjectRef | null): void;
  /**
   * Point at somebody, or at nobody with null.
   *
   * The client decides *who*, because choosing a target is pointing at something
   * on a screen; this side decides *whether and how often* a blow lands, because
   * that is the board's business and a client cannot be trusted with its own
   * attack speed. A target on its own is only a target — see
   * {@link setAttackMode}.
   */
  setTarget(actorId: string | null): void;
  /** Swing at the target, or merely keep it. @see GameSnapshot.attacking */
  setAttackMode(enabled: boolean): void;
  canInteract(ref: ObjectRef): boolean;
  interact(ref: ObjectRef): boolean;
  /**
   * Take the thing at this slot into your kit.
   *
   * On the interface rather than left to {@link interact}, because the list
   * offers pick-up as its own row and a row that named one action and ran
   * whatever `interact` happened to choose would be lying about what a tap
   * does.
   */
  pickUp(ref: ObjectRef): boolean;
  /**
   * Would this move be honoured right now?
   *
   * Asked by whatever is drawing the drag, so a slot lights up only where the
   * thing would actually land. Same function the move itself runs, which is what
   * stops the interface offering something a drop would refuse.
   */
  canMoveItem(from: SlotRef, to: SlotRef): boolean;
  /** Move a carried thing from one slot to another. @see canMoveItem */
  moveItem(from: SlotRef, to: SlotRef): boolean;
}

/**
 * The tail of a push. The object lands in the map the instant it is shoved, so
 * everything that queries the board — walking into the cell it vacated above
 * all — sees the truth immediately; this is the animation catching up. Holding
 * the commit back would not remove the halfway state, only hide it from the
 * map, where every collision check is looking.
 */
type SlideState = {
  /** The object at its new home. */
  object: ObjectRef;
  from: Coord;
  elapsedMs: number;
};

/**
 * Everything that belongs to one actor rather than to the board.
 *
 * The board's own state — the map, plate and wire indexes, what has settled —
 * stays on the session: a plate does not care which actor stepped on it.
 */
type ActorRuntime = {
  readonly id: string;
  /**
   * Lives in the map rather than on a socket, so nothing outside will ever
   * drive it. Recorded when the actor is created because that is the only
   * moment the distinction is free — after that it would mean asking the board
   * what kind of body this is, once per creature per tick.
   */
  readonly resident: boolean;
  /**
   * What this actor is wearing and carrying. See `./equipment`.
   *
   * On the runtime rather than on the placement, on exactly the terms {@link hp}
   * is: a placement field would broadcast itself through cell patches, and every
   * equip would dirty the light chunks and level geometry around the player for
   * a change nothing in the world can see.
   *
   * Unlike `hp` and `brain` this is *not* something a fresh runtime can rebuild
   * from the tile — it is the only state here that a world owes continuity for,
   * because what somebody is carrying came from somewhere. Persisting it is
   * Phase 6; until then a reconnect hands out a fresh kit.
   */
  equipment: Equipment;
  /**
   * Where this creature is in its state machine, or null for a body with no
   * brain — every player, and any creature whose authored brain did not parse.
   * Built on first use rather than at adoption, which is what makes "brain
   * state resets on load" free: a fresh runtime has no memory to restore.
   */
  brain: BrainMemory | null;
  /**
   * Hit points, or null for a body that has never had any read.
   *
   * Filled on first use rather than at creation, which is what makes it free:
   * the stats live on the tile the actor *is*, and at creation the body may not
   * be on the board yet. Null therefore means "ask the tile", and a body with no
   * battler block leaves it null forever. See {@link GameSession.hpOf}.
   *
   * Deliberately absent from the checkpoint, exactly like {@link brain}: a world
   * nobody is looking at owes no continuity, and the alternative is a saved
   * number that has to survive somebody editing the tile's max.
   */
  hp: number | null;
  /** Milliseconds until this body may swing again. See `./combat`. */
  attackCooldownMs: number;
  /** Who this actor is set on, for a body driven by somebody pointing at things. */
  targetId: string | null;
  /**
   * Whether a target is somebody to fight or merely somebody being watched.
   *
   * Off by default, and the two halves of what used to be one decision:
   * {@link targetId} says *who*, this says *whether to swing*. Pointing at
   * something is how a player asks about it — a name tag, a health bar, a row in
   * the list — and before this the only way to look at a creature that closely
   * was to start a fight with it.
   *
   * Per actor rather than per session because it arrives on a socket like every
   * other thing a player asks for, and a brain never sets it: a creature's
   * aggression is its brain's `attack` action, which goes straight to
   * {@link GameSession.tryAttack} and never through a standing target.
   */
  attacking: boolean;
  input: GameInput;
  walk: WalkState | null;
  fall: FallState | null;
  slide: SlideState | null;
  hovered: ObjectRef | null;
  /**
   * Location memo, keyed on the map object it was read from.
   *
   * Map mutation is persistent, so object identity is an exact staleness check:
   * this recomputes once per edit and never returns a stale answer.
   */
  memo: { map: MapFile; loc: ActorLocation } | null;
};

/**
 * Authoritative play session. Mutates an in-memory map; no DOM / renderer.
 *
 * Holds any number of actors. `/play` runs exactly one and never names it; the
 * game server spawns one per connection.
 */
export class GameSession implements PlaySession {
  private map: MapFile;
  private readonly tilesById: Record<string, TileDef>;
  /** Insertion-ordered, which is what makes {@link tick} deterministic. */
  private readonly actors = new Map<string, ActorRuntime>();
  private readonly spawnAt: Coord & { stackIndex: number };
  /**
   * Cells holding a pressure plate, so settling reads a handful of columns
   * instead of the whole board every tick. Kept true by
   * {@link reindexCells} at the few sites that can relocate a plate; a stale
   * extra entry only costs a wasted stack read, a missing one is a dead plate.
   */
  /**
   * Actors whose kit has changed and whose owner has not been told yet.
   *
   * Ids rather than the kits themselves: by the time this is drained the
   * equipment on the runtime is the current one, and holding a copy here would
   * be a second version of the truth going stale between the tick that changed
   * it and the flush that sends it.
   */
  private readonly equipmentChanged = new Set<string>();
  private readonly plateCells = new Map<string, Coord>();
  /**
   * Cells holding a placement wired to a signal channel — emitters and
   * receivers alike, since reading a channel means finding both. Same index
   * discipline as {@link plateCells}.
   */
  private readonly wiredCells = new Map<string, Coord>();
  /**
   * Cells holding a gravity body no runtime drives — a crate, a barrel. The
   * settle pass drops these; an actor animates its own fall and is excluded by
   * its owner. Same index discipline as {@link plateCells}.
   */
  private readonly looseGravityCells = new Map<string, Coord>();
  /** Map identity the last settle pass read. See {@link settleBoardNow}. */
  private settledMap: MapFile | null = null;
  private accumulatorMs = 0;
  /**
   * The world's dice, shared by every brain in it.
   *
   * One stream rather than one per creature, which makes actor order part of
   * what makes a world reproducible — the same order that already decides who
   * wins a contested cell.
   */
  private readonly rng: Rng;
  /** Time towards the next round of decisions. See {@link BRAIN_TICK_MS}. */
  private brainAccumulatorMs = 0;
  /**
   * What creatures said this tick, waiting to be broadcast.
   *
   * Emptied at the top of every tick and refilled by whatever brains say during
   * it, so it only ever holds the current tick's speech. The server drains it
   * after the tick and turns each line into the same chat a player sends; a
   * session running with no wire — offline `/play` — simply never drains it, and
   * the per-tick reset keeps that from leaking. Speech stays an online-only
   * thing, as {@link getSnapshot} already declares.
   */
  private pendingSpeech: ChatBubble[] = [];
  /** Ticks up per line, so two things said in one tick are two bubbles. */
  private nextSpeechId = 0;
  /**
   * What has been said *to* the world since the brains last had a turn.
   *
   * The mirror of {@link pendingSpeech}, and the reason it is a separate list
   * rather than the same one: that holds what creatures said and empties every
   * tick on its way to the wire, while this holds what people said and empties
   * on the slower brain clock, because a brain that ticks once per six ticks
   * would otherwise miss five sixths of everything shouted at it.
   *
   * Held only until the next round of decisions. An utterance is an event, not a
   * state of the world: a creature hears a thing said once, and a word left
   * lying here would be heard again by whoever ticks next.
   */
  private pendingHeard: Utterance[] = [];
  /**
   * Who has hit whom since the brains last had a turn, as `target -> attackers`.
   *
   * The exact counterpart of {@link pendingHeard}, cleared on the same slower
   * clock and for the same reason: a brain gets one chance to notice a blow, and
   * a blow left lying here would be noticed again by whoever ticks next. Indexed
   * by target because that is the only question ever asked of it — "was I hit,
   * and by whom" — and a flat list would mean every creature walking every blow
   * struck anywhere in the world.
   */
  private pendingHurt = new Map<string, string[]>();
  /**
   * Damage dealt this tick, waiting to be broadcast. Drained by the server
   * exactly as {@link pendingSpeech} is, and emptied at the top of every tick so
   * a session with no wire cannot accumulate it.
   */
  private pendingDamage: DamageNumber[] = [];
  /**
   * Damage still on screen, aged down by the tick loop.
   *
   * Separate from {@link pendingDamage} because the two answer different
   * questions: that one is "what happened in the last tick", which the wire
   * wants once, and this is "what a viewer should still be able to see", which
   * outlives it by a couple of seconds. Both are fed by the same blow.
   */
  private liveDamage: DamageNumber[] = [];
  /** Ticks up per blow, so two hits in one tick are two numbers. */
  private nextDamageId = 0;
  /**
   * Who died this tick, waiting to be noticed.
   *
   * The session cannot act on a death beyond removing the body — whether the
   * connection behind it is kept out of the world afterwards is the server's
   * question, and this is how it hears about one. Drained like speech and
   * damage; a session with no wire never asks.
   */
  private pendingDeaths: string[] = [];
  /**
   * The creature-driven emitters the last settle pass saw, as a signature.
   *
   * A brain entering or leaving a state that holds a channel changes nothing on
   * the map — the body has not moved — so the map-identity skip in
   * {@link settleBoardNow} would sail straight past it and the door would never
   * hear. This is the other half of that skip: when the minds driving the wires
   * change, the pass runs even though the board looks untouched.
   */
  private settledEmitters = "";

  /**
   * @param actorIds actors to start with. The default adopts the authored
   *   `player` tile as a single local actor, which is what `/play` wants; pass
   *   an empty array to open an empty world and {@link spawn} into it.
   * @param spawnAt where actors enter. Omit for an authored map, and it is read
   *   from the `player` tile, which is then consumed — adopted by the first
   *   actor or removed. **Required when resuming a map that has already been
   *   run**, because that map no longer has a marker to read: it was consumed
   *   the first time. Rediscovering it is impossible, so it has to be carried
   *   alongside.
   * @param seed where the world's dice start. Carried in the checkpoint for the
   *   same reason `spawnAt` is — resuming from the opening seed would replay
   *   the wander the world had already played. Omit for a fresh world.
   */
  constructor(
    map: MapFile,
    tiles: TileDef[],
    actorIds: readonly string[] = [LOCAL_ACTOR_ID],
    spawnAt?: Coord & { stackIndex: number },
    seed?: number,
  ) {
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);
    this.rng = new Rng(seed);

    if (spawnAt) {
      this.spawnAt = spawnAt;
      for (const id of actorIds) this.spawn(id);
    } else {
      this.spawnAt = spawnPoint(this.map);
      // The first actor adopts the authored tile rather than spawning beside
      // it, so a single-actor session is the map it was handed, tagged — the
      // tile keeps its slot in the stack, and with it the elevation it stands
      // at.
      const [first, ...rest] = actorIds;
      if (first === undefined) {
        this.map = removeAuthoredPlayer(this.map);
      } else {
        this.map = adoptAuthoredPlayer(this.map, first);
        this.addActor(first);
      }
      for (const id of rest) this.spawn(id);
    }

    // After the connecting actors, and before anything reads the board: a
    // resident is on the map whether or not anybody is here to see it.
    this.adoptResidents();

    // Before anything can pick one up, and idempotent against a resumed world
    // whose items were minted the last time it loaded.
    this.map = mintItemIds(this.map, this.tilesById);

    for (const cell of findPlateCells(this.map, this.tilesById)) {
      this.plateCells.set(cellKey(cell), cell);
    }
    for (const cell of findWiredCells(this.map)) {
      this.wiredCells.set(cellKey(cell), cell);
    }
    for (const cell of findLooseGravityCells(this.map, this.tilesById)) {
      this.looseGravityCells.set(cellKey(cell), cell);
    }
    // An authored map opens in the state its load implies — a boulder already
    // sitting on a plate means that plate starts pressed, not pressed one tick
    // after the player first sees it, and the door that plate drives starts
    // open.
    this.settleBoardNow();
  }

  /**
   * Give every body that lives in the map an actor to drive it.
   *
   * Placing the tile is the whole of putting an NPC in the world — there is no
   * spawner and nothing to author beyond the placement itself. Idempotent
   * against a resumed world: a body that already carries an owner keeps it and
   * only gains its runtime back, because re-minting would hand the same
   * creature a second identity and leave the first one on the board forever.
   *
   * The locations are read once, up front, and stayed reliable while the loop
   * rewrites the map: adoption only ever writes an owner onto a placement, so
   * nothing moves out from under the scan.
   */
  private adoptResidents() {
    for (const body of listResidentBodies(this.map, this.tilesById)) {
      const owner = body.placed.owner ?? residentOwnerId(body);
      if (!body.placed.owner) {
        this.map = adoptBodyAt(this.map, body, owner);
      }
      if (!this.actors.has(owner)) this.addActor(owner, { resident: true });
    }
  }

  private addActor(
    id: string,
    opts: { resident?: boolean } = {},
  ): ActorRuntime {
    const resident = opts.resident === true;
    const actor: ActorRuntime = {
      id,
      resident,
      // Only people get a kit. A deer is an actor in every other respect, and
      // could carry things the day something wants it to — but handing every
      // creature in the world a backpack it will never open is a bag per body
      // to seat, checkpoint and diff for nothing.
      equipment: resident
        ? emptyEquipment()
        : startingEquipment(this.tilesById, STARTING_BAG_TILE_ID),
      brain: null,
      hp: null,
      attackCooldownMs: 0,
      targetId: null,
      attacking: false,
      input: { directions: [] },
      walk: null,
      fall: null,
      slide: null,
      hovered: null,
      memo: null,
    };
    this.actors.set(id, actor);
    return actor;
  }

  /**
   * Put an actor on the board.
   *
   * Idempotent against the *map*, not just the actor table: a resumed world
   * already holds the tiles of everyone who was standing in it, and minting a
   * second body for them would leave one behind forever — `despawn` only ever
   * removes one. So an actor who already has a tile is re-seated on it, keeping
   * where they were rather than being sent back to spawn.
   *
   * No reindex: an actor tile is never a plate and never wired, so which cells
   * carry those is unchanged. Arriving on a plate still presses it — the map
   * identity changed, so the next {@link settleBoardNow} will not skip.
   *
   * @param at where this actor was standing the last time anyone saw them.
   *   Consulted only when they have no tile on the board — a body already in
   *   the map is more recent than any memory of one — and honoured only if it
   *   still has room for them; see {@link findEntryCell}. Omit for an actor the
   *   world has never met, who enters at the spawn point.
   */
  spawn(id: string, at?: Coord & { direction?: Direction }) {
    if (this.actors.has(id)) return;
    if (!findActorAnywhere(this.map, id)) {
      const cell = at
        ? findEntryCell(this.map, this.tilesById, at, this.spawnAt)
        : this.spawnAt;
      this.map = spawnActor(this.map, id, cell, at?.direction);
    }
    this.addActor(id);
  }

  /**
   * Where an actor is standing right now, and which way they are facing.
   *
   * Null rather than a throw when nobody by that name is on the board: both
   * callers are persistence and cleanup, and neither has anything useful to do
   * with an exception.
   */
  actorPosition(id: string): ActorPosition | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    return {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      direction: actorDirection(loc),
    };
  }

  /**
   * Remove the bodies of actors nobody is driving.
   *
   * A world resumed from a checkpoint carries whoever was standing in it, and
   * some of those connections are gone — they died while the object was
   * evicted, so no close ever ran for them. Called with the set that is
   * genuinely connected.
   */
  reapAbsentActors(present: Iterable<string>) {
    const live = new Set(present);
    // Residents are nobody's connection, so they are absent from every list of
    // who is connected — reaping on that alone would clear the world of its
    // wildlife on the first wake after an eviction. Read off the board rather
    // than tracked beside it, and by the same rule adoption uses, so the two
    // cannot come to disagree about what a resident is.
    const residents = new Set(
      listResidentBodies(this.map, this.tilesById)
        .map((body) => body.placed.owner)
        .filter((owner): owner is string => owner != null),
    );
    for (const owner of listActorOwners(this.map)) {
      if (live.has(owner) || residents.has(owner)) continue;
      this.map = despawnActor(this.map, owner);
    }
  }

  /**
   * Take an actor off the board. Their tile goes with them, and a plate they
   * were holding down releases on the next tick by the same identity check.
   */
  despawn(id: string) {
    if (!this.actors.delete(id)) return;
    this.map = despawnActor(this.map, id);
  }

  actorIds(): string[] {
    return [...this.actors.keys()];
  }

  /**
   * What one actor is carrying, or null when nobody by that name is here.
   *
   * Null rather than an empty kit, because the two mean different things to the
   * server: an actor with nothing is somebody to send an empty inventory to,
   * and an actor who has died or never joined is somebody to send nothing at
   * all. Only the server asks — a local viewer reads theirs off the snapshot.
   */
  equipmentOf(id: string): Equipment | null {
    return this.actors.get(id)?.equipment ?? null;
  }

  /**
   * Where actors enter. Must be carried alongside any map this session is
   * checkpointed into — see the constructor.
   */
  getSpawnPoint(): Coord & { stackIndex: number } {
    return this.spawnAt;
  }

  /**
   * The dice as they stand, to be handed back to the constructor on resume.
   *
   * Must be checkpointed alongside the map: restoring a world from the seed it
   * opened with would replay the wander it had already played, which is the one
   * thing a fresh draw exists to avoid.
   */
  getSeed(): number {
    return this.rng.save();
  }

  private actor(id: string): ActorRuntime {
    const actor = this.actors.get(id);
    if (!actor) throw new Error(`No actor "${id}" in this session`);
    return actor;
  }

  /** Keep both indexes true for cells whose stack just changed. */
  private reindexCells(cells: Iterable<Coord>) {
    for (const cell of cells) {
      const key = cellKey(cell);
      if (cellHasPlate(this.map, cell, this.tilesById)) {
        this.plateCells.set(key, cell);
      } else {
        this.plateCells.delete(key);
      }
      if (cellIsWired(this.map, cell)) {
        this.wiredCells.set(key, cell);
      } else {
        this.wiredCells.delete(key);
      }
      if (cellHasLooseGravity(this.map, cell, this.tilesById)) {
        this.looseGravityCells.set(key, cell);
      } else {
        this.looseGravityCells.delete(key);
      }
    }
  }

  /**
   * Bring the board in line with itself: unsupported bodies drop, then plates
   * follow what now rests on them, then receivers follow the channels those
   * plates drive.
   *
   * Gravity first, and all in the same tick, so a crate whose floor was pulled
   * lands and presses its plate — and opens the door that plate drives — on the
   * frame the floor goes rather than a tick later, one settle bleeding into the
   * next.
   *
   * The skip is on map identity, not a dirty flag: the map is copy-on-write, so
   * an unchanged map cannot have changed a plate's load or a channel's value.
   * The identity recorded is the one read *before* the pass, which is what lets
   * a swap that shifts another plate's load — or drives another channel —
   * settle on the next tick rather than being mistaken for a board at rest.
   */
  private settleBoardNow() {
    const before = this.map;
    const emitters = this.actorEmitters();
    const emitterSig = this.emitterSignature(emitters);
    // Two ways the board can owe a pass: the map changed, or a mind driving a
    // wire did. The second leaves no trace on the map, so it needs its own say.
    if (before === this.settledMap && emitterSig === this.settledEmitters) return;
    this.settledMap = before;
    this.settledEmitters = emitterSig;

    if (this.looseGravityCells.size > 0) {
      const { map, changed } = settleGravity(
        this.map,
        this.looseGravityCells.values(),
        this.tilesById,
      );
      this.map = map;
      this.reindexCells(changed);
    }

    if (this.plateCells.size > 0) {
      const { map, changed } = settlePlates(
        this.map,
        this.plateCells.values(),
        this.tilesById,
      );
      this.map = map;
      this.reindexCells(changed);
    }

    if (this.wiredCells.size > 0) {
      const { map, changed } = settleSignals(
        this.map,
        this.wiredCells.values(),
        this.tilesById,
        emitters,
      );
      this.map = map;
      this.reindexCells(changed);
    }
  }

  /**
   * Where an actor is, without sweeping the map unless they actually moved.
   *
   * A single tick can rewrite the map several times — commit a step, then
   * settle a plate under it — and every rewrite makes the memo stale. Nearly
   * all of those edits leave the actor exactly where they were, so confirming
   * the one cell is enough; only a real relocation costs more.
   */
  private tryLocate(actor: ActorRuntime): ActorLocation | null {
    const memo = actor.memo;
    if (memo?.map === this.map) return memo.loc;

    const loc = locateActor(this.map, actor.id, memo?.loc);
    if (loc) actor.memo = { map: this.map, loc };
    return loc;
  }

  private locate(actor: ActorRuntime): ActorLocation {
    const loc = this.tryLocate(actor);
    if (!loc) throw new Error(`Actor "${actor.id}" is not on the map`);
    return loc;
  }

  setInput(input: GameInput, id: string = LOCAL_ACTOR_ID) {
    this.actor(id).input = input;
  }

  /** Advance by real-time `dtMs`, running fixed ticks. */
  update(dtMs: number) {
    this.accumulatorMs += dtMs;
    const maxCatchUp = TICK_MS * 10;
    if (this.accumulatorMs > maxCatchUp) this.accumulatorMs = maxCatchUp;

    while (this.accumulatorMs >= TICK_MS) {
      this.accumulatorMs -= TICK_MS;
      this.tick(TICK_MS);
    }
  }

  /**
   * Single fixed tick.
   *
   * Actors move in insertion order, and that order is load-bearing: two actors
   * stepping into the same cell on the same tick resolve by it, so a stable
   * order is what makes a tick reproducible rather than dependent on which
   * message happened to arrive first.
   */
  tick(tickMs: number = TICK_MS) {
    // Last tick's speech has been broadcast or discarded; this tick starts with
    // an empty page, so anything left undrained cannot pile up.
    this.pendingSpeech = [];
    this.pendingDamage = [];
    this.ageDamageNumbers(tickMs);

    // Before anything swings, so a body whose cooldown expires on this tick can
    // spend it on this tick — whether the swing comes from a brain below or from
    // somebody's target above.
    this.advanceCooldowns(tickMs);

    // Before the bodies move, so a decision taken now starts its walk on this
    // tick rather than the next.
    this.tickBrains(tickMs);

    // After the brains, so a creature that decided to close the distance this
    // tick is not also hit by a player's auto-attack before it has moved.
    this.runAutoAttacks();

    for (const actor of this.actors.values()) {
      // Independent of the actor: a shoved object keeps travelling whatever
      // they do next.
      this.tickSlide(actor, tickMs);
      this.tickMotion(actor, tickMs);
    }
    // Last, and once for the whole board: plates and channels answer to the
    // board the tick leaves behind, not to any particular actor having caused
    // it. Running this per actor would settle the same plates N times.
    this.settleBoardNow();
  }

  /**
   * Is anybody here to see it?
   *
   * Brains run only while somebody is connected, and this is the whole test:
   * every actor is either somebody's connection or lives in the map, so "a
   * non-resident exists" is "a player is present" without the session needing
   * to know a socket from a hole in the ground.
   */
  private observed(): boolean {
    for (const actor of this.actors.values()) {
      if (!actor.resident) return true;
    }
    return false;
  }

  /**
   * Let every brain decide, at its own slower cadence.
   *
   * Frozen while nobody is connected, and that is a cost decision rather than a
   * fiction about the world: the tick loop keeps a Durable Object out of
   * hibernation, so a single deer on a five-second timer would hold an empty
   * world awake forever, for nobody. What freezes is *deciding* — a body
   * already mid-step finishes it, because `isAtRest` waits on motion and a step
   * abandoned halfway would checkpoint a creature between two cells, which the
   * whole simulation is written to make impossible.
   *
   * The accumulator is drained rather than reset, so the phase of the brain
   * clock survives a quiet spell instead of restarting on the next join.
   */
  private tickBrains(tickMs: number) {
    if (!this.observed()) {
      // Nobody here to have said it, and nobody left to hear it. Dropping the
      // page rather than keeping it is what stops a word shouted on the way out
      // of the door from greeting the next person to walk in.
      this.pendingHeard = [];
      this.pendingHurt.clear();
      return;
    }

    this.brainAccumulatorMs += tickMs;
    if (this.brainAccumulatorMs < BRAIN_TICK_MS) return;
    this.brainAccumulatorMs -= BRAIN_TICK_MS;

    for (const actor of this.actors.values()) {
      if (!actor.resident) continue;
      this.tickOneBrain(actor);
    }

    // Every brain has now had its one chance at this round of speech. Clearing
    // after the whole pass rather than per creature is what makes one word
    // reach every ear at once — and clearing at all is what keeps it an event
    // instead of a standing fact about the world.
    this.pendingHeard = [];
    // And its one chance to notice being hit, on the same terms: a blow is an
    // event, so a creature that was struck reacts once rather than reacting
    // forever to a fact that never goes away.
    this.pendingHurt.clear();
  }

  /**
   * Somebody said something out loud, for any brain near enough to notice.
   *
   * The server's to call, on the same message it broadcasts as chat — this is
   * the simulation's copy of it, and the only reason the simulation gets one.
   * Words that no creature is listening for cost a push and a clear.
   *
   * Deliberately not called for {@link recordSpeech}: creatures do not hear each
   * other yet. Wiring it would be one line and the machinery is ready for it,
   * but a deer's yelp setting off every brain in earshot is a world's worth of
   * behaviour to think about rather than a side effect of this.
   */
  hear(speakerId: string, text: string) {
    this.pendingHeard.push({ speakerId, text });
  }

  private tickOneBrain(actor: ActorRuntime) {
    // A body with no brain, or one whose authored brain did not hold together,
    // simply stands there. Resolving is memoised on def identity, so asking
    // every tick costs a map lookup rather than a parse.
    const brain = resolveBrain(this.defFor(actor));
    if (!brain) return;

    const loc = this.locate(actor);
    actor.brain ??= initialMemory(brain);
    stepBrain(brain, actor.brain, BRAIN_TICK_MS, {
      busy: !this.idle(actor),
      rng: this.rng,
      self: { x: loc.x, y: loc.y, z: loc.z },
      nearestPlayerId: () => this.nearestPlayerId(loc),
      positionOf: (id) => this.actorCell(id),
      wouldDrop: (direction) => this.stepLeavesGround(loc, direction),
      step: (direction) =>
        this.applyStepRequest(actor, { directions: [direction] }),
      say: (text) => this.recordSpeech(actor, loc, text),
      canSee: (at) =>
        hasLineOfSight(
          this.map,
          this.tilesById,
          { x: loc.x, y: loc.y, z: loc.z },
          at,
        ),
      heard: () => this.pendingHeard,
      hurtBy: () => this.pendingHurt.get(actor.id) ?? EMPTY_ATTACKERS,
      attack: (id) => this.tryAttack(actor, id),
    });
  }

  /**
   * Note something a creature said, at the cell it said it in.
   *
   * Sanitised here, once, on the same terms a player's message is — so an NPC
   * cannot say anything a person could not, and the bubble a viewer sees is the
   * bubble the rules allow. A line that survives to nothing is simply not
   * recorded; an authored `!` always will.
   *
   * Pinned to the cell and the stack slot, like every bubble, so it hangs over
   * the ground the creature stands on rather than over its own head.
   */
  private recordSpeech(actor: ActorRuntime, loc: ActorLocation, raw: string) {
    const text = sanitizeChatText(raw);
    if (!text) return;
    this.pendingSpeech.push({
      id: `say-${this.nextSpeechId++}`,
      actorId: actor.id,
      tileId: loc.placed.tileId,
      text,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
  }

  /**
   * Everything a creature said this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}: it broadcasts each line to
   * the level it was said on, exactly as a player's chat. Nobody else calls it,
   * and the next tick would clear the list regardless — draining is how the
   * speech reaches a wire, not how it is kept from piling up.
   */
  drainSpeech(): ChatBubble[] {
    const said = this.pendingSpeech;
    this.pendingSpeech = [];
    return said;
  }

  /**
   * Everything that took a blow this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}, exactly as
   * {@link drainSpeech} is. A session with no wire — offline `/play` — never
   * drains it, and the per-tick reset keeps that from leaking; the numbers a
   * local viewer sees come from {@link getSnapshot} instead.
   */
  drainDamage(): DamageNumber[] {
    const dealt = this.pendingDamage;
    this.pendingDamage = [];
    return dealt;
  }

  /**
   * Everybody whose body ran out of hit points this tick, handed over once.
   *
   * Not cleared by the next tick, unlike speech and damage: a death is the one
   * thing here the caller *must* not miss — a server that dropped one would put
   * the actor back on the board at the next wake, undoing it.
   */
  drainDeaths(): string[] {
    const died = this.pendingDeaths;
    this.pendingDeaths = [];
    return died;
  }

  /** Wind every cooldown down towards its next swing. */
  private advanceCooldowns(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (actor.attackCooldownMs > 0) {
        actor.attackCooldownMs = Math.max(0, actor.attackCooldownMs - tickMs);
      }
    }
  }

  /**
   * Swing for everybody in attack mode who has picked a fight and is standing
   * close enough.
   *
   * Auto rather than per click, because {@link BattlerDef.spd} is what decides
   * how often a body swings. A client that had to ask for each blow would be
   * asking for permission it is going to be refused most of the time, and a
   * client that asked *faster* would gain nothing — which is precisely the
   * property worth having on a wire anybody can write to.
   *
   * Failing quietly is the whole behaviour here: out of reach, on cooldown, or
   * aimed at something with no hit points all simply do not swing. Only a target
   * that has left the world is worth clearing, because a slot pointing at
   * nobody would keep this looking them up forever — and that clearing happens
   * whether or not anybody is swinging, since a target outlives the mode.
   */
  private runAutoAttacks() {
    for (const actor of this.actors.values()) {
      const targetId = actor.targetId;
      if (targetId === null) continue;
      if (!this.actors.has(targetId)) {
        actor.targetId = null;
        continue;
      }
      if (!actor.attacking) continue;
      this.tryAttack(actor, targetId);
    }
  }

  /**
   * One body swings at another, if every reason not to is absent.
   *
   * The single path from "somebody wants to attack" to a blow, whether the
   * wanting came from a brain's `attack` action or from a player's standing
   * target. Returning false rather than throwing at each refusal is what lets
   * the brain's priority list fall through — see the `attack` action.
   */
  private tryAttack(attacker: ActorRuntime, targetId: string): boolean {
    if (attacker.attackCooldownMs > 0) return false;
    if (targetId === attacker.id) return false;

    const target = this.actors.get(targetId);
    if (!target) return false;

    // Both ends have to be battlers, and reading it off the body is what makes
    // "attack anything, fail graciously" true: swinging at a crate is a lookup
    // that comes back null, not a special case anybody had to write.
    const attackerStats = this.battlerOf(attacker);
    const targetStats = this.battlerOf(target);
    if (!attackerStats || !targetStats) return false;

    const from = this.tryLocate(attacker);
    const to = this.tryLocate(target);
    if (!from || !to) return false;
    if (!inAttackRange(from, to)) return false;

    // Spent whether or not the blow connects: the swing happened, and a dodge
    // that cost the attacker nothing would let a fast creature flail for free.
    attacker.attackCooldownMs = attackIntervalMs(attackerStats.spd);

    // Turning into the blow, so a creature that fights while cornered is facing
    // what it is fighting. Free when it already is — `setEntityDirection` guards
    // the no-op, which matters because this runs on every swing.
    const facing = facingToward(from, to);
    if (facing) {
      this.map = setEntityDirection(
        this.map,
        from.x,
        from.y,
        from.z,
        from.stackIndex,
        facing,
      );
    }

    const outcome = rollAttack(attackerStats, targetStats, this.rng);
    // Noted even on a dodge: what a creature reacts to is being swung at, and a
    // cat that only fought back when a blow landed would stand there being
    // missed. Before the damage, so a killing blow still tells the room.
    this.notePendingHurt(target.id, attacker.id);
    if (outcome.dodged) return true;

    this.applyDamage(target, outcome.damage);
    return true;
  }

  /** Remember who hit whom, for the brains' next round of decisions. */
  private notePendingHurt(targetId: string, attackerId: string) {
    const attackers = this.pendingHurt.get(targetId);
    if (attackers) attackers.push(attackerId);
    else this.pendingHurt.set(targetId, [attackerId]);
  }

  /**
   * Take hit points off a body, and take the body off the board if that empties
   * it.
   *
   * The number is recorded before the death, and carries the cell rather than
   * relying on the actor still being findable: by the time anything draws it,
   * the body it came off may be gone.
   */
  private applyDamage(target: ActorRuntime, amount: number) {
    const before = this.hpOf(target);
    if (before === null) return;

    const loc = this.tryLocate(target);
    if (loc) {
      const number: DamageNumber = {
        id: `hit-${this.nextDamageId++}`,
        targetId: target.id,
        amount,
        x: loc.x,
        y: loc.y,
        z: loc.z,
        stackIndex: loc.stackIndex,
        elapsedMs: 0,
      };
      this.pendingDamage.push(number);
      this.liveDamage.push(number);
    }

    const after = before - amount;
    target.hp = Math.max(0, after);
    if (target.hp === 0) this.kill(target);
  }

  /**
   * Take a body off the board for good.
   *
   * The tile goes and so does the runtime, which for a player is exactly the
   * intent: with no actor by that name the server ignores everything their
   * socket sends, so a dead player can sit there connected and do nothing until
   * they reload and are handed a fresh body. There is no respawn.
   *
   * Everyone aiming at them is released here rather than discovering it later,
   * so nothing is left swinging at a slot that can never be filled again.
   */
  private kill(target: ActorRuntime) {
    this.actors.delete(target.id);
    this.pendingDeaths.push(target.id);
    this.map = despawnActor(this.map, target.id);
    this.pendingHurt.delete(target.id);
    for (const actor of this.actors.values()) {
      if (actor.targetId === target.id) actor.targetId = null;
    }
    // The cell they were standing in has one fewer thing in it, which is a real
    // change to what rests on a plate and to what is holding a crate up.
    const loc = target.memo?.loc;
    if (loc) this.reindexCells([{ x: loc.x, y: loc.y, z: loc.z }]);
  }

  /** Age the floating numbers out, on the tick clock like every other timer. */
  private ageDamageNumbers(tickMs: number) {
    if (this.liveDamage.length === 0) return;
    let expired = false;
    for (const number of this.liveDamage) {
      number.elapsedMs += tickMs;
      if (number.elapsedMs >= DAMAGE_NUMBER_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.liveDamage = this.liveDamage.filter(
        (number) => number.elapsedMs < DAMAGE_NUMBER_LIFETIME_MS,
      );
    }
  }

  /**
   * The stat block of whatever body this actor is in, equipment counted, or
   * null for a body with no stats at all.
   *
   * **The single place stats are answered**, which is what makes a weapon apply
   * everywhere without anything else having to remember to ask: the swing reads
   * it, the cooldown reads it, and the health bar's maximum reads it. A second
   * caller of `resolveBattler` would be a body that fights with its sword and
   * one that does not, depending on who asked.
   */
  private battlerOf(actor: ActorRuntime): BattlerDef | null {
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    const def = this.tilesById[loc.placed.tileId];
    const base = def ? resolveBattler(def) : null;
    if (!base) return null;
    return effectiveBattler(base, actor.equipment, this.tilesById);
  }

  /**
   * Hit points as they stand, filling them in from the tile the first time
   * anybody asks.
   *
   * Lazy because that is the only way it can be cheap *and* right: the stats
   * live on the body, a body can be swapped underneath an actor, and at the
   * moment an actor is created it may have no body at all. Null means the body
   * has none to give.
   */
  private hpOf(actor: ActorRuntime): number | null {
    const stats = this.battlerOf(actor);
    if (!stats) return null;
    actor.hp ??= stats.maxHp;
    // Clamped on read rather than on edit, so lowering a tile's maximum in the
    // editor cannot leave a creature standing there overfull.
    return Math.min(actor.hp, stats.maxHp);
  }

  /**
   * Point an actor at somebody, or at nobody.
   *
   * Nothing is validated here beyond the id being a string: whether the target
   * can actually be hit is decided every time a swing is attempted, and it has
   * to be, because reach changes as both parties walk. A target that is merely
   * out of range is a target being kept, not a bad one.
   */
  setTarget(actorId: string | null, id: string = LOCAL_ACTOR_ID) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.targetId = actorId === actor.id ? null : actorId;
  }

  /**
   * Turn swinging on or off, leaving whoever is targeted targeted.
   *
   * The other half of {@link setTarget}, and separate from it because the two
   * are separate decisions a player makes at different moments: they pick who
   * they are interested in by pointing at them, and they decide whether they are
   * fighting by flipping a mode that outlives any one target. Toggling it off
   * mid-fight is how you back out of one without losing sight of what you were
   * backing out of.
   */
  setAttackMode(enabled: boolean, id: string = LOCAL_ACTOR_ID) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.attacking = enabled;
  }

  /**
   * The channels creatures are holding open right now, one entry per emitting
   * mind. Read straight off each brain's current state, so a creature that has
   * moved on is simply not among them and the wire it was driving falls quiet.
   */
  private actorEmitters(): ExtraEmitter[] {
    const out: ExtraEmitter[] = [];
    for (const actor of this.actors.values()) {
      const state = actor.brain?.state;
      if (state === undefined) continue;
      const emit = resolveBrain(this.defFor(actor))?.states[state]?.emit;
      if (emit) out.push({ channel: emit.channel, value: emit.value });
    }
    return out;
  }

  /**
   * The emitting minds as one string, for the {@link settleBoardNow} skip.
   *
   * Insertion order, which is already what makes a tick reproducible, so the
   * same set of held channels always renders the same signature and an unchanged
   * mind never looks like a changed one.
   */
  private emitterSignature(emitters: ExtraEmitter[]): string {
    return emitters.map((e) => `${e.channel}=${e.value}`).join(",");
  }

  /**
   * Would a step this way land on nothing?
   *
   * The same band `canWalk` measures against, asked separately rather than
   * folded into it: the board deliberately permits walking into open air so
   * gravity can pull an actor through a steeper drop, and that rule is shared
   * with the client's own prediction. Changing it for creatures would put the
   * two out of step over the one thing they must agree on. So the caution lives
   * out here, where a brain can choose it per action.
   */
  private stepLeavesGround(loc: ActorLocation, direction: Direction): boolean {
    const { dx, dy } = DIR_DELTA[direction];
    const fromAbs = standingAbs(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      this.tilesById,
    );
    return !listStandingSurfaces(
      this.map,
      loc.x + dx,
      loc.y + dy,
      this.tilesById,
    ).some(
      (surface) =>
        surface.abs >= fromAbs - MAX_CLIMB_HEIGHT &&
        surface.abs <= fromAbs + MAX_CLIMB_HEIGHT,
    );
  }

  /**
   * Whichever connected player is fewest steps away, or null in an empty world.
   *
   * Residents are skipped, so this is "the nearest *person*" — a deer does not
   * flee another deer. Ties break on insertion order, the same order that
   * already decides who wins a contested cell, which keeps the answer
   * reproducible rather than dependent on a map sweep's traversal.
   */
  private nearestPlayerId(from: Coord): string | null {
    let best: string | null = null;
    let bestSteps = Infinity;
    for (const actor of this.actors.values()) {
      if (actor.resident) continue;
      const loc = this.tryLocate(actor);
      if (!loc) continue;
      const steps = Math.abs(loc.x - from.x) + Math.abs(loc.y - from.y);
      if (steps < bestSteps) {
        bestSteps = steps;
        best = actor.id;
      }
    }
    return best;
  }

  /** Where an actor is standing, or null once they are off the board. */
  private actorCell(id: string): Coord | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    return loc ? { x: loc.x, y: loc.y, z: loc.z } : null;
  }

  /**
   * Hands free? Own motion owns the map until it settles; a slide no longer
   * does, but is still held against the actor so pushes cannot be machine-
   * gunned out faster than the object can be seen leaving.
   */
  private idle(actor: ActorRuntime): boolean {
    return !actor.slide && !actor.walk && !actor.fall;
  }

  canPush(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canPushFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  /**
   * Shove the object one cell directly away from the actor. Returns false
   * when the push is illegal — a blocked push is a no-op, not an error state.
   */
  push(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

    const loc = this.locate(actor);
    const to = pushTargetFrom(this.map, this.tilesById, loc, ref);
    const direction = pushDirectionFrom(loc, ref);
    if (!to || !direction) return false;

    // The shove is what turns the actor, so facing lands before the motion.
    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      direction,
    );

    const from = { x: ref.x, y: ref.y, z: ref.z };
    this.map = moveEntity(this.map, ref, to, undefined, this.tilesById);

    // moveEntity appends, so the object is the top of the destination stack.
    const stackIndex = getStack(this.map, to.x, to.y, to.z).length - 1;
    actor.slide = { object: { ...to, stackIndex }, from, elapsedMs: 0 };
    // The object itself may be a plate, so both ends of the shove are suspect.
    this.reindexCells([from, to]);
    return true;
  }

  canPickUp(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canPickUpFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
    );
  }

  /**
   * Take the thing off the board and into this actor's kit.
   *
   * The placement becomes an instance and the map loses it, which is the whole
   * operation — a container comes up with its `contents` intact because those
   * ride on the placement, so nothing here has to know a bag from a sword.
   *
   * Returns false when the pickup is illegal, on the same terms a blocked push
   * does: a refusal is a no-op, not an error state.
   */
  pickUp(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

    const loc = this.locate(actor);
    const destination = pickUpDestination(
      this.map,
      this.tilesById,
      loc,
      ref,
      actor.equipment,
    );
    if (!destination) return false;

    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const instance = placed && instanceFromPlacement(placed);
    // An item with no identity means something skipped the minting pass. Better
    // a pickup that does nothing than one that puts an anonymous thing in a bag
    // and loses track of it forever.
    if (!instance) return false;

    this.setEquipment(
      actor,
      destination === "bag-slot"
        ? { ...actor.equipment, bag: instance }
        : {
            ...actor.equipment,
            bag: {
              ...actor.equipment.bag!,
              contents: [...(actor.equipment.bag!.contents ?? []), instance],
            },
          },
    );

    this.map = removeTileAt(this.map, ref.x, ref.y, ref.z, ref.stackIndex);
    // The cell has one fewer thing in it, which is a real change to what rests
    // on a plate and to what was holding a crate up.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  canMoveItem(
    from: SlotRef,
    to: SlotRef,
    id: string = LOCAL_ACTOR_ID,
  ): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    return canMoveItem(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      from,
      to,
    );
  }

  /**
   * Move one carried thing from one slot to another.
   *
   * Equipping, unequipping, looting a chest and stashing something into one are
   * all this, read four ways — see `./itemMoves`, which owns every rule the move
   * has to satisfy and is asked the same question by the client before it offers
   * the drag.
   *
   * Not gated on {@link idle}, unlike a push or a pickup. Those two move the
   * *board* and are held against the actor so they cannot be machine-gunned out
   * faster than the result can be seen; this rearranges what somebody is
   * carrying, and refusing to let a walking player put a sword in their hand
   * would be a rule with nothing behind it. Reach for a ground endpoint is
   * re-asked here regardless, against the cell the actor has committed to.
   *
   * No settle pass: a container's contents are not physics. Rewriting them
   * changes what a placement *holds* and never its tile, so nothing rests
   * differently on a plate and no wire has changed value — and the map identity
   * has moved anyway, so the next tick's pass will not skip.
   */
  moveItem(from: SlotRef, to: SlotRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    const loc = this.tryLocate(actor);
    if (!loc) return false;

    const moved = applyItemMove(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      from,
      to,
    );
    if (!moved) return false;

    this.map = moved.map;
    // Only when it actually changed: `setEquipment` is what tells the owner's
    // socket, and a loot from one chest into another is nobody's kit changing.
    if (moved.equipment !== actor.equipment) {
      this.setEquipment(actor, moved.equipment);
    }
    return true;
  }

  /**
   * Put a whole new kit on an actor.
   *
   * **Replaces rather than mutates, and that is load-bearing.** The renderer
   * hands equipment to React only when the object identity changes — see
   * `GameRenderer.setOnEquipment` — so a kit edited in place would leave the
   * panels showing what the player was carrying a moment ago, with nothing to
   * correct it. Every change goes through here for that reason.
   */
  private setEquipment(actor: ActorRuntime, next: Equipment) {
    actor.equipment = next;
    this.equipmentChanged.add(actor.id);
  }

  /**
   * Whose kit has changed since the last time anybody asked, and clears the
   * list.
   *
   * Drained rather than read, because there is exactly one consumer: the server
   * turning it into a message per socket. A second reader would silently get an
   * empty answer, which is the right shape here — this is a queue of things to
   * announce, not a record of what happened.
   */
  drainEquipmentChanges(): string[] {
    if (this.equipmentChanged.size === 0) return [];
    const changed = [...this.equipmentChanged];
    this.equipmentChanged.clear();
    return changed;
  }

  canSwitch(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canSwitchFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  /** Replace the object with its switch target. Returns false when blocked. */
  activateSwitch(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    if (!this.canSwitch(ref, id)) return false;
    const loc = this.locate(this.actor(id));
    const def = interactiveDefAt(this.map, this.tilesById, loc, ref);
    const sw = def && resolveSwitch(def);
    if (!def || !sw) return false;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    // Only the tile id changes. The slot's own state — facing, signal channel,
    // owner — belongs to the placement, not to whichever tile is filling it.
    const next = stack.map((placed, i) =>
      i === ref.stackIndex ? { ...placed, tileId: sw.targetTileId } : placed,
    );
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    // The tile switched into may be a plate — or may have been one.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  /**
   * The one thing a tap on this object does. Everything an actor can do to
   * an object lives behind a single button, so the tile's own capabilities
   * pick the action rather than the input device — switch wins when authored,
   * push is the fallback. Returns false when nothing happened.
   *
   * Settles before returning, because this is the one edit that happens
   * *between* ticks: input arrives whenever it arrives, while everything else
   * that moves the board does so inside {@link tick}, which settles at the end.
   * Movement therefore reads the board at the top of a tick as already
   * answered-for, and an unsettled edit sitting there is a lie it will act on.
   *
   * A wired door is where that bites. Tapping one is allowed — a door may want
   * to be both tappable and overruled by its channel — but the tap used to
   * leave it open for the rest of the frame, which was long enough for a held
   * direction to start a step through a doorway the channel was about to shut.
   * The step is authorised once and committed later regardless, so the player
   * ended up through a locked door, or standing on top of it. Closed → tap →
   * open → channel disagrees → closed now happens with nothing in between.
   */
  interact(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const acted =
      this.activateSwitch(ref, id) || this.pickUp(ref, id) || this.push(ref, id);
    if (acted) this.settleBoardNow();
    return acted;
  }

  /**
   * Renderer reports what the pointer is over; whether it counts is decided on
   * read, not here. Reach changes as the actor walks and as objects settle,
   * and a pointer that has not moved must not keep an outline alive that the
   * actor can no longer act on.
   */
  setHoveredObject(ref: ObjectRef | null, id: string = LOCAL_ACTOR_ID) {
    this.actor(id).hovered = ref;
  }

  /** Is there anything a tap on this object would do right now? */
  canInteract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    return (
      this.canSwitch(ref, id) || this.canPickUp(ref, id) || this.canPush(ref, id)
    );
  }

  private tickSlide(actor: ActorRuntime, tickMs: number) {
    if (!actor.slide) return;
    actor.slide.elapsedMs += tickMs;
    // Nothing to commit — the sprite has simply arrived where the map already
    // put it, so dropping the state is the whole of "landing".
    if (actor.slide.elapsedMs >= PUSH_STEP_MS) actor.slide = null;
  }

  /** One actor's own motion for one tick — walking, falling, or starting to. */
  private tickMotion(actor: ActorRuntime, tickMs: number) {
    if (actor.fall) {
      this.tickFall(actor, tickMs);
      return;
    }

    if (actor.walk) {
      actor.walk.elapsedMs += tickMs;
      if (actor.walk.elapsedMs >= actor.walk.durationMs) {
        this.commitWalk(actor);
      } else {
        return;
      }
    }

    this.maybeStartFall(actor);
    if (actor.fall) return;

    this.maybeStartWalk(actor);
  }

  private actorSnapshot(actor: ActorRuntime): ActorSnapshot {
    const loc = this.locate(actor);
    // Include leftover accumulator so 60fps+ renders interpolate between 30Hz ticks.
    const visualExtra = this.accumulatorMs;
    return {
      id: actor.id,
      tileId: loc.placed.tileId,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: actor.walk,
      fall: actor.fall,
      walkProgress: actor.walk
        ? Math.min(1, (actor.walk.elapsedMs + visualExtra) / actor.walk.durationMs)
        : 0,
      // Unclamped, unlike the walk: a fall is a run of height units rather than
      // one lerp, and the tick that commits a unit lands after the unit's time
      // is up. Clamping there froze the sprite for a tick at every boundary and
      // then lurched it. Past 1 is exactly what the next step will confirm.
      fallProgress: actor.fall
        ? (actor.fall.elapsedMs + visualExtra) / FALL_MS_PER_HEIGHT
        : 0,
      // Handed over by reference, exactly as `walk` and `fall` are: it is
      // mutated in place as it advances, so the same slide across two ticks is
      // the same object and the server can tell a continuing push from a new one.
      slide: actor.slide,
      slideProgress: actor.slide
        ? Math.min(1, (actor.slide.elapsedMs + visualExtra) / PUSH_STEP_MS)
        : 0,
      hp: this.hpOf(actor),
      maxHp: this.battlerOf(actor)?.maxHp ?? null,
    };
  }

  /**
   * Every actor, with no viewpoint. What the server broadcasts — it is not
   * looking at the world from anywhere.
   */
  actorSnapshots(): ActorSnapshot[] {
    return [...this.actors.values()].map((a) => this.actorSnapshot(a));
  }

  getSnapshot(id: string = LOCAL_ACTOR_ID): GameSnapshot {
    const self = this.actor(id);
    const actors = this.actorSnapshots();
    const mine = actors.find((a) => a.id === self.id)!;
    return {
      map: this.map,
      self: mine,
      actors,
      hover:
        self.hovered && this.canInteract(self.hovered, id) ? self.hovered : null,
      targetId: self.targetId,
      attacking: self.attacking,
      equipment: self.equipment,
      // Nobody to talk to: the local simulation has no wire and no other actors
      // worth naming, so speech is a thing only the online client carries.
      chats: [],
      damage: this.liveDamage,
    };
  }

  /**
   * Nothing is moving and nobody is asking to move.
   *
   * The server ticks only while this is false, so an idle world costs nothing
   * and its Durable Object can hibernate with sockets still open. The board
   * clause is the settle convergence condition rather than a flag: a pass that
   * changed something leaves `map !== settledMap`, so the world keeps ticking
   * until plates and channels agree with each other.
   */
  isAtRest(): boolean {
    // Something has been said that no brain has had a turn to hear. Resting on
    // it would stop the clock that was going to deliver it — and unlike a
    // wander, which merely happens later, this one never happens at all: the
    // next tick clears the page. A world with nothing else to do stays awake
    // for one brain tick and settles again.
    if (this.pendingHeard.length > 0) return false;
    // A blow nobody has had a turn to notice, on exactly the same grounds: the
    // next brain tick is what delivers it, and stopping the clock now would drop
    // it entirely rather than merely delay it.
    if (this.pendingHurt.size > 0) return false;

    let observed = false;
    let thinking = false;
    for (const actor of this.actors.values()) {
      if (actor.walk || actor.fall || actor.slide) return false;
      if (actor.input.directions.length > 0) return false;
      // Somebody standing still next to the thing they are fighting is not an
      // idle world: the next swing is on a cooldown that only this loop winds
      // down, so resting here would end the fight by falling asleep in it.
      //
      // Gated on attack mode, and that gate is what keeps targeting free: a
      // target held with the mode off produces no blows and no cooldowns, so a
      // player standing there watching a deer must not hold the world awake for
      // as long as they keep it in sight.
      if (actor.attacking && actor.targetId !== null) return false;
      if (!actor.resident) {
        observed = true;
      } else if (!thinking) {
        thinking = this.thinks(actor);
      }
    }

    // A creature counting down to its next move is pending work, even with
    // nothing on the board moving. Without this the loop stops the moment a
    // player stands still, which freezes the very timer that would have started
    // the next wander — stand still and the wildlife stops existing. Gated on
    // somebody being here, so an empty world is still free: that is the whole
    // bargain, and it is why brains freeze rather than run on an alarm.
    if (observed && thinking) return false;

    return this.map === this.settledMap;
  }

  /** Does this actor have a brain that is going to want a turn? */
  private thinks(actor: ActorRuntime): boolean {
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    const def = this.tilesById[loc.placed.tileId];
    return def != null && resolveBrain(def) !== null;
  }

  getMap(): MapFile {
    return this.map;
  }

  /**
   * The tile an actor *is*, which is what every rule about their motion has to
   * be asked against.
   *
   * This was the player's def for everybody, which was true for exactly as long
   * as every actor was a person. A deer is a different height, may climb
   * differently, and need not answer to gravity at all — reading the def off
   * the body means none of that is a special case, and a new creature is a tile
   * rather than a branch.
   *
   * Read through the location memo rather than stored on the runtime, because
   * the body can be swapped underneath an actor and a copy would go stale.
   */
  private defFor(actor: ActorRuntime): TileDef {
    const { placed } = this.locate(actor);
    const def = this.tilesById[placed.tileId];
    if (!def) throw new Error(`Missing tile def "${placed.tileId}"`);
    return def;
  }

  private commitWalk(actor: ActorRuntime) {
    const w = actor.walk;
    if (!w) return;
    const loc = this.locate(actor);
    this.map = moveEntity(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      w.to,
      w.direction,
      this.tilesById,
    );
    actor.walk = null;
  }

  /**
   * Is another actor already walking into this cell?
   *
   * A walk commits to the map only when it lands, so for the whole step the
   * destination still reads as empty to everyone else. Two actors pressing the
   * same direction on the same tick therefore both pass {@link canWalk} and
   * both arrive, ending up inside one another — the map cannot answer this
   * question because the answer is not in the map yet.
   *
   * Reserving the destination rather than committing the move up front keeps
   * the existing rule that a step is only real once it lands, which the whole
   * of gravity and plate settling is written against.
   */
  private destinationTaken(cell: Coord, except: ActorRuntime): boolean {
    for (const other of this.actors.values()) {
      if (other === except) continue;
      const to = other.walk?.to;
      if (to && to.x === cell.x && to.y === cell.y && to.z === cell.z) {
        return true;
      }
    }
    return false;
  }

  private maybeStartWalk(actor: ActorRuntime) {
    this.applyStepRequest(actor, actor.input);
  }

  /**
   * Turn, and walk if the board allows it. The one path from "what is being
   * asked for" to "what the actor does", whether the asking is a held key in
   * `/play` or a step a networked client has already predicted.
   */
  private applyStepRequest(
    actor: ActorRuntime,
    request: StepRequest,
  ): boolean {
    const loc = this.locate(actor);
    const choice = chooseStep(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      request,
      this.defFor(actor),
      this.tilesById,
      (to) => this.destinationTaken(to, actor),
    );
    if (!choice) return false;

    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      choice.facing,
    );

    if (!choice.step) return false;

    actor.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs: 0,
      durationMs: resolveWalkDurationMs(this.defFor(actor)),
    };
    return true;
  }

  /**
   * Take one step, because a client says it has already taken it.
   *
   * The other way in besides held input, and the one online play uses. A
   * browser predicting its own movement decides *when* a step happens — that is
   * the whole point, since waiting for this object to decide is the latency
   * being removed — and this re-runs the same rule against the authoritative
   * board to decide whether it is allowed to have happened.
   *
   * Deciding when does not mean deciding how fast: a step is only taken while
   * the actor is free, so a client sending a thousand of these walks at exactly
   * the same pace as one sending the honest four per second.
   *
   * `"later"` is the answer for an actor still finishing a walk, and it is not a
   * refusal — the client is half a round trip ahead by design, so its next
   * intent routinely arrives a few milliseconds before this side is done with
   * the last one. The caller holds it and asks again. A fall or a slide *is* a
   * refusal: those are motion the client did not predict, so whatever it thought
   * it was doing is already void.
   */
  requestStep(
    id: string,
    direction: Direction,
    opts?: { preferDescend?: boolean },
  ): "started" | "later" | "refused" {
    const actor = this.actor(id);
    if (actor.fall || actor.slide) return "refused";
    if (actor.walk) return "later";

    const started = this.applyStepRequest(actor, {
      directions: [direction],
      preferDescend: opts?.preferDescend,
    });
    return started ? "started" : "refused";
  }

  /** Turn an actor on the spot, without asking them to go anywhere. */
  faceActor(id: string, direction: Direction) {
    const actor = this.actor(id);
    const loc = this.locate(actor);
    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      direction,
    );
  }

  private maybeStartFall(actor: ActorRuntime) {
    if (!this.defFor(actor).affectedByGravity) return;

    const loc = this.locate(actor);
    if (
      isSupported(this.map, loc.x, loc.y, loc.z, loc.stackIndex, this.tilesById)
    ) {
      return;
    }

    const feetAbs = standingAbs(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      this.tilesById,
    );
    const landing = findLandingAbs(this.map, loc.x, loc.y, feetAbs, this.tilesById, {
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
    if (landing == null || landing >= feetAbs) return;

    // Drops within climb height are step-downs (same as same-level height
    // change) — snap onto the surface instead of playing a fall.
    if (feetAbs - landing <= MAX_CLIMB_HEIGHT) {
      this.land(actor, landing);
      return;
    }

    actor.fall = { feetAbs, landingAbs: landing, elapsedMs: 0 };
  }

  private tickFall(actor: ActorRuntime, tickMs: number) {
    if (!actor.fall) return;
    actor.fall.elapsedMs += tickMs;

    while (actor.fall && actor.fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
      actor.fall.elapsedMs -= FALL_MS_PER_HEIGHT;
      this.stepFallOneHeight(actor);
    }
  }

  private stepFallOneHeight(actor: ActorRuntime) {
    if (!actor.fall) return;

    const nextFeet = actor.fall.feetAbs - 1;
    if (nextFeet <= actor.fall.landingAbs) {
      this.land(actor, actor.fall.landingAbs);
      return;
    }

    actor.fall.feetAbs = nextFeet;
    this.relocateActorToFeet(actor, nextFeet);
  }

  private land(actor: ActorRuntime, landingAbs: number) {
    actor.fall = null;
    const loc = this.locate(actor);
    const exclude = { z: loc.z, stackIndex: loc.stackIndex };

    if (
      !isWalkableSurfaceAt(
        this.map,
        loc.x,
        loc.y,
        landingAbs,
        this.tilesById,
        exclude,
      )
    ) {
      this.commitLandAt(actor, landingAbs);
      const after = this.locate(actor);
      const facing = actorDirection(after);
      const slide = canWalk(
        this.map,
        { x: after.x, y: after.y, z: after.z, stackIndex: after.stackIndex },
        facing,
        this.defFor(actor),
        this.tilesById,
      );
      if (slide.ok) {
        actor.walk = {
          from: { x: after.x, y: after.y, z: after.z },
          to: slide.to,
          direction: facing,
          elapsedMs: 0,
          durationMs: resolveWalkDurationMs(this.defFor(actor)),
        };
        return;
      }

      const nextWalkable = findWalkableLandingAbs(
        this.map,
        after.x,
        after.y,
        landingAbs,
        this.tilesById,
        { z: after.z, stackIndex: after.stackIndex },
      );
      if (nextWalkable != null && nextWalkable < landingAbs) {
        const feetAbs = standingAbs(
          this.map,
          after.x,
          after.y,
          after.z,
          after.stackIndex,
          this.tilesById,
        );
        if (feetAbs - nextWalkable <= MAX_CLIMB_HEIGHT) {
          this.commitLandAt(actor, nextWalkable);
          return;
        }
        actor.fall = { feetAbs, landingAbs: nextWalkable, elapsedMs: 0 };
        return;
      }
      return;
    }

    this.commitLandAt(actor, landingAbs);
  }

  private commitLandAt(actor: ActorRuntime, landingAbs: number) {
    const loc = this.locate(actor);
    const { z: targetZ } = cellForFeetAbs(landingAbs);
    const placed = { ...loc.placed };

    const next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    // Prefer attaching onto scenery whose top matches the landing.
    for (const zTry of [targetZ, targetZ - 1, loc.z]) {
      if (zTry < MIN_LEVEL) continue;
      const stack = getStack(next, loc.x, loc.y, zTry);
      if (stack.length === 0) continue;
      const top = absoluteStandingElevation(zTry, stack, this.tilesById);
      if (top === landingAbs) {
        this.map = placeEntityOnSurface(
          next,
          loc.x,
          loc.y,
          zTry,
          placed,
          this.tilesById,
        );
        return;
      }
    }

    this.map = appendTile(next, loc.x, loc.y, targetZ, placed);
  }

  private relocateActorToFeet(actor: ActorRuntime, feetAbs: number) {
    const loc = this.locate(actor);
    const { z: newZ } = cellForFeetAbs(feetAbs);
    if (newZ === loc.z) return;

    const placed = { ...loc.placed };
    let next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    const destStack = getStack(next, loc.x, loc.y, newZ);
    const destTop = absoluteStandingElevation(newZ, destStack, this.tilesById);
    if (destStack.length > 0 && destTop === feetAbs) {
      next = placeEntityOnSurface(
        next,
        loc.x,
        loc.y,
        newZ,
        placed,
        this.tilesById,
      );
    } else {
      next = appendTile(next, loc.x, loc.y, newZ, placed);
    }
    this.map = next;
  }
}
