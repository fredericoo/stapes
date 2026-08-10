import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isWalkableSurfaceAt,
  replaceStack,
} from "../lib/mapData";
import { resolveSwitch } from "../lib/interactions";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { MIN_LEVEL } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  actorDirection,
  adoptAuthoredPlayer,
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
  canPushFrom,
  canSwitchFrom,
  interactiveDefAt,
  pushDirectionFrom,
  pushTargetFrom,
  type ObjectRef,
} from "./affordances";
import { findEntryCell } from "./entry";
import {
  FALL_MS_PER_HEIGHT,
  MAX_CLIMB_HEIGHT,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
import {
  cellForFeetAbs,
  findLandingAbs,
  findWalkableLandingAbs,
  isSupported,
} from "./gravity";
import {
  moveEntity,
  placeEntityOnSurface,
  removeEntity,
  setEntityDirection,
} from "./mapMutations";
import { canWalk, standingAbs } from "./movement";
import { chooseStep, type StepRequest } from "./stepping";
import {
  cellHasPlate,
  cellKey,
  findPlateCells,
  settlePlates,
} from "./pressurePlates";
import { cellIsWired, findWiredCells, settleSignals } from "./signals";

export type { ObjectRef } from "./affordances";

export type WalkState = {
  from: Coord;
  to: Coord;
  direction: Direction;
  elapsedMs: number;
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

/** A pushed object whose sprite is still catching up to where it already is. */
export type SlideSnapshot = {
  /** The object at its committed cell — the move is already in the map. */
  object: ObjectRef;
  from: Coord;
  progress: number;
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
  canInteract(ref: ObjectRef): boolean;
  interact(ref: ObjectRef): boolean;
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
  private readonly plateCells = new Map<string, Coord>();
  /**
   * Cells holding a placement wired to a signal channel — emitters and
   * receivers alike, since reading a channel means finding both. Same index
   * discipline as {@link plateCells}.
   */
  private readonly wiredCells = new Map<string, Coord>();
  /** Map identity the last settle pass read. See {@link settleBoardNow}. */
  private settledMap: MapFile | null = null;
  private accumulatorMs = 0;

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
   */
  constructor(
    map: MapFile,
    tiles: TileDef[],
    actorIds: readonly string[] = [LOCAL_ACTOR_ID],
    spawnAt?: Coord & { stackIndex: number },
  ) {
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);

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

    for (const cell of findPlateCells(this.map, this.tilesById)) {
      this.plateCells.set(cellKey(cell), cell);
    }
    for (const cell of findWiredCells(this.map)) {
      this.wiredCells.set(cellKey(cell), cell);
    }
    // An authored map opens in the state its load implies — a boulder already
    // sitting on a plate means that plate starts pressed, not pressed one tick
    // after the player first sees it, and the door that plate drives starts
    // open.
    this.settleBoardNow();
  }

  private addActor(id: string): ActorRuntime {
    const actor: ActorRuntime = {
      id,
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
    for (const owner of listActorOwners(this.map)) {
      if (!live.has(owner)) this.map = despawnActor(this.map, owner);
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
   * Where actors enter. Must be carried alongside any map this session is
   * checkpointed into — see the constructor.
   */
  getSpawnPoint(): Coord & { stackIndex: number } {
    return this.spawnAt;
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
    }
  }

  /**
   * Bring the board in line with itself: plates follow what rests on them,
   * then receivers follow the channels those plates now drive.
   *
   * Plates first, and in the same tick, so a plate pressed by this tick's step
   * opens its door on the frame the player sees the step land rather than the
   * one after.
   *
   * The skip is on map identity, not a dirty flag: the map is copy-on-write, so
   * an unchanged map cannot have changed a plate's load or a channel's value.
   * The identity recorded is the one read *before* the pass, which is what lets
   * a swap that shifts another plate's load — or drives another channel —
   * settle on the next tick rather than being mistaken for a board at rest.
   */
  private settleBoardNow() {
    const before = this.map;
    if (before === this.settledMap) return;
    this.settledMap = before;

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
    const acted = this.activateSwitch(ref, id) || this.push(ref, id);
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
    return this.canSwitch(ref, id) || this.canPush(ref, id);
  }

  private tickSlide(actor: ActorRuntime, tickMs: number) {
    if (!actor.slide) return;
    actor.slide.elapsedMs += tickMs;
    // Nothing to commit — the sprite has simply arrived where the map already
    // put it, so dropping the state is the whole of "landing".
    if (actor.slide.elapsedMs >= PUSH_STEP_MS) actor.slide = null;
  }

  private slideSnapshot(actor: ActorRuntime): SlideSnapshot | null {
    const slide = actor.slide;
    if (!slide) return null;
    return {
      object: slide.object,
      from: slide.from,
      progress: Math.min(
        1,
        (slide.elapsedMs + this.accumulatorMs) / PUSH_STEP_MS,
      ),
    };
  }

  /** One actor's own motion for one tick — walking, falling, or starting to. */
  private tickMotion(actor: ActorRuntime, tickMs: number) {
    if (actor.fall) {
      this.tickFall(actor, tickMs);
      return;
    }

    if (actor.walk) {
      actor.walk.elapsedMs += tickMs;
      if (actor.walk.elapsedMs >= WALK_DURATION_MS) {
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
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: actor.walk,
      fall: actor.fall,
      walkProgress: actor.walk
        ? Math.min(1, (actor.walk.elapsedMs + visualExtra) / WALK_DURATION_MS)
        : 0,
      // Unclamped, unlike the walk: a fall is a run of height units rather than
      // one lerp, and the tick that commits a unit lands after the unit's time
      // is up. Clamping there froze the sprite for a tick at every boundary and
      // then lurched it. Past 1 is exactly what the next step will confirm.
      fallProgress: actor.fall
        ? (actor.fall.elapsedMs + visualExtra) / FALL_MS_PER_HEIGHT
        : 0,
      slide: this.slideSnapshot(actor),
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
      // Nobody to talk to: the local simulation has no wire and no other actors
      // worth naming, so speech is a thing only the online client carries.
      chats: [],
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
    for (const actor of this.actors.values()) {
      if (actor.walk || actor.fall || actor.slide) return false;
      if (actor.input.directions.length > 0) return false;
    }
    return this.map === this.settledMap;
  }

  getMap(): MapFile {
    return this.map;
  }

  private playerDef(): TileDef {
    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) throw new Error(`Missing tile def "${PLAYER_TILE_ID}"`);
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
      this.playerDef(),
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
    const def = this.playerDef();
    if (!def.affectedByGravity) return;

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
        this.playerDef(),
        this.tilesById,
      );
      if (slide.ok) {
        actor.walk = {
          from: { x: after.x, y: after.y, z: after.z },
          to: slide.to,
          direction: facing,
          elapsedMs: 0,
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
