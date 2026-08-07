import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isWalkableSurfaceAt,
  replaceStack,
} from "../lib/mapData";
import { isInteractive, resolvePush, resolveSwitch } from "../lib/interactions";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { MIN_LEVEL } from "../lib/types";
import { canReplaceStack, tilesByIdFromList } from "../lib/validation";
import { pushDestination } from "./push";
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
import {
  findPlayerNear,
  playerDirection,
  playerStillAt,
  requireSinglePlayer,
  type PlayerLocation,
} from "./player";
import {
  cellHasPlate,
  cellKey,
  findPlateCells,
  settlePlates,
} from "./pressurePlates";

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

/** A specific placed tile in the map — cell plus slot in its stack. */
export type ObjectRef = Coord & { stackIndex: number };

/** A pushed object whose sprite is still catching up to where it already is. */
export type SlideSnapshot = {
  /** The object at its committed cell — the move is already in the map. */
  object: ObjectRef;
  /** Cell it is sliding out of. Visual only; nothing occupies it any more. */
  from: Coord;
  /** 0–1 through the tile. */
  progress: number;
};

export type GameSnapshot = {
  map: MapFile;
  player: Coord & { stackIndex: number; direction: Direction };
  walk: WalkState | null;
  fall: FallState | null;
  walkProgress: number;
  fallProgress: number;
  /** Object under the pointer that the player can act on right now, if any. */
  hover: ObjectRef | null;
  slide: SlideSnapshot | null;
};

/** Floors above/below the player that still count for hover and interaction. */
const INTERACT_LEVEL_SLACK = 1;

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
 * Authoritative play session. Mutates an in-memory map; no DOM / renderer.
 */
export class GameSession {
  private map: MapFile;
  /**
   * Player location memo, keyed on the map object it was read from.
   *
   * Finding the player is a full sweep, and a single frame asks several times
   * over — once for the snapshot, again for each hover affordance test. Map
   * mutation is persistent, so object identity is an exact staleness check:
   * this recomputes once per edit and never returns a stale answer.
   */
  private playerMemo: { map: MapFile; loc: PlayerLocation } | null = null;
  private readonly tilesById: Record<string, TileDef>;
  private input: GameInput = { directions: [] };
  private walk: WalkState | null = null;
  private fall: FallState | null = null;
  private accumulatorMs = 0;
  private hovered: ObjectRef | null = null;
  private slide: SlideState | null = null;
  /**
   * Cells holding a pressure plate, so settling reads a handful of columns
   * instead of the whole board every tick. Kept true by
   * {@link reindexPlates} at the few sites that can relocate a plate; a stale
   * extra entry only costs a wasted stack read, a missing one is a dead plate.
   */
  private readonly plateCells = new Map<string, Coord>();
  /** Map identity the last settle pass read. See {@link settlePlatesNow}. */
  private settledMap: MapFile | null = null;

  constructor(map: MapFile, tiles: TileDef[]) {
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);
    requireSinglePlayer(this.map);

    for (const cell of findPlateCells(this.map, this.tilesById)) {
      this.plateCells.set(cellKey(cell), cell);
    }
    // An authored map opens in the state its load implies — a boulder already
    // sitting on a plate means that plate starts pressed, not pressed one tick
    // after the player first sees it.
    this.settlePlatesNow();
  }

  /** Keep the plate index true for cells whose stack just changed. */
  private reindexPlates(cells: Iterable<Coord>) {
    for (const cell of cells) {
      const key = cellKey(cell);
      if (cellHasPlate(this.map, cell, this.tilesById)) {
        this.plateCells.set(key, cell);
      } else {
        this.plateCells.delete(key);
      }
    }
  }

  /**
   * Bring every plate in line with what is resting on it.
   *
   * The skip is on map identity, not a dirty flag: the map is copy-on-write, so
   * an unchanged map cannot have changed a plate's load. The identity recorded
   * is the one read *before* the pass, which is what lets a swap that shifts
   * another plate's load settle on the next tick rather than being mistaken for
   * a board at rest.
   */
  private settlePlatesNow() {
    if (this.plateCells.size === 0) return;
    const before = this.map;
    if (before === this.settledMap) return;
    this.settledMap = before;

    const { map, changed } = settlePlates(
      before,
      this.plateCells.values(),
      this.tilesById,
    );
    this.map = map;
    this.reindexPlates(changed);
  }

  /**
   * The player, without sweeping the map unless they actually moved.
   *
   * A single tick can rewrite the map several times — commit a step, then
   * settle a plate under it — and every rewrite makes the memo stale. Nearly
   * all of those edits leave the player exactly where they were, so confirming
   * the one cell is enough; only a real relocation falls back to the sweep.
   */
  private player(): PlayerLocation {
    const memo = this.playerMemo;
    if (memo?.map === this.map) return memo.loc;

    const stillThere = memo && playerStillAt(this.map, memo.loc);
    const nearby = stillThere ?? (memo && findPlayerNear(this.map, memo.loc));
    const loc = nearby || requireSinglePlayer(this.map);
    this.playerMemo = { map: this.map, loc };
    return loc;
  }

  setInput(input: GameInput) {
    this.input = input;
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
   * Interactive object at a stack slot, if the player could be looking at it.
   * Reach extends one floor above and below the standing level. Buried under
   * another tile is still out: only the top of a stack can be acted on.
   */
  private interactiveDefAt(ref: ObjectRef): TileDef | null {
    const loc = this.player();
    if (Math.abs(ref.z - loc.z) > INTERACT_LEVEL_SLACK) return null;
    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    if (ref.stackIndex !== stack.length - 1) return null;
    const placed = stack[ref.stackIndex];
    if (!placed) return null;
    const def = this.tilesById[placed.tileId];
    if (!def || !isInteractive(def)) return null;
    return def;
  }

  /**
   * Direction the player would shove this object, or null when they are not
   * standing next to it. Orthogonal only: a diagonal push has no unambiguous
   * "one cell further away" cell, and reading it off the board is guesswork.
   * Floors are not part of the test — reaching one level up or down is fine
   * (see {@link INTERACT_LEVEL_SLACK}); it is the plan view that must touch.
   */
  private pushDirectionFor(ref: ObjectRef): Direction | null {
    const loc = this.player();
    const dx = ref.x - loc.x;
    const dy = ref.y - loc.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
    if (dx === 1) return "e";
    if (dx === -1) return "w";
    return dy === 1 ? "s" : "n";
  }

  /**
   * Hands free? Own motion owns the map until it settles; a slide no longer
   * does, but is still held against the player so pushes cannot be machine-
   * gunned out faster than the object can be seen leaving.
   */
  private idle(): boolean {
    return !this.slide && !this.walk && !this.fall;
  }

  /** Where this object would land if pushed right now, or null when it cannot be. */
  private pushTargetFor(ref: ObjectRef): Coord | null {
    if (!this.idle()) return null;
    const def = this.interactiveDefAt(ref);
    const push = def && resolvePush(def);
    if (!def || !push) return null;

    const direction = this.pushDirectionFor(ref);
    if (!direction) return null;

    const check = pushDestination(
      this.map,
      ref,
      direction,
      def,
      push,
      this.tilesById,
    );
    return check.ok ? check.to : null;
  }

  canPush(ref: ObjectRef): boolean {
    return this.pushTargetFor(ref) != null;
  }

  /**
   * Shove the object one cell directly away from the player. Returns false
   * when the push is illegal — a blocked push is a no-op, not an error state.
   */
  push(ref: ObjectRef): boolean {
    const to = this.pushTargetFor(ref);
    const direction = this.pushDirectionFor(ref);
    if (!to || !direction) return false;

    // The shove is what turns the player, so facing lands before the motion.
    const loc = this.player();
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
    this.slide = {
      object: { ...to, stackIndex },
      from,
      elapsedMs: 0,
    };
    // The object itself may be a plate, so both ends of the shove are suspect.
    this.reindexPlates([from, to]);
    return true;
  }

  /**
   * Can the player switch this object right now? Same reach / busy gates as
   * push; also requires the target tile to fit in this stack slot.
   */
  canSwitch(ref: ObjectRef): boolean {
    if (!this.idle()) return false;
    const def = this.interactiveDefAt(ref);
    const sw = def && resolveSwitch(def);
    if (!def || !sw || !this.pushDirectionFor(ref)) return false;
    return this.switchWouldFit(ref, sw.targetTileId);
  }

  /** Replace the object with its switch target. Returns false when blocked. */
  activateSwitch(ref: ObjectRef): boolean {
    if (!this.canSwitch(ref)) return false;
    const def = this.interactiveDefAt(ref);
    const sw = def && resolveSwitch(def);
    if (!def || !sw) return false;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const next = stack.map((placed, i) =>
      i === ref.stackIndex
        ? { tileId: sw.targetTileId, direction: placed.direction }
        : placed,
    );
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    // The tile switched into may be a plate — or may have been one.
    this.reindexPlates([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  /**
   * The one thing a tap on this object does. Everything the player can do to
   * an object lives behind a single button, so the tile's own capabilities
   * pick the action rather than the input device — switch wins when authored,
   * push is the fallback. Returns false when nothing happened.
   */
  interact(ref: ObjectRef): boolean {
    return this.activateSwitch(ref) || this.push(ref);
  }

  private switchWouldFit(ref: ObjectRef, targetTileId: string): boolean {
    if (!this.tilesById[targetTileId]) return false;
    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const placed = stack[ref.stackIndex];
    if (!placed) return false;
    const next = stack.map((p, i) =>
      i === ref.stackIndex
        ? { tileId: targetTileId, direction: p.direction }
        : p,
    );
    return canReplaceStack(
      this.map,
      ref.x,
      ref.y,
      ref.z,
      next,
      this.tilesById,
    ).ok;
  }

  /**
   * Renderer reports what the pointer is over; whether it counts is decided on
   * read, not here. Reach changes as the player walks and as objects settle,
   * and a pointer that has not moved must not keep an outline alive that the
   * player can no longer act on.
   */
  setHoveredObject(ref: ObjectRef | null) {
    this.hovered = ref;
  }

  /** Is there anything a tap on this object would do right now? */
  canInteract(ref: ObjectRef): boolean {
    return this.canSwitch(ref) || this.canPush(ref);
  }

  private tickSlide(tickMs: number) {
    if (!this.slide) return;
    this.slide.elapsedMs += tickMs;
    // Nothing to commit — the sprite has simply arrived where the map already
    // put it, so dropping the state is the whole of "landing".
    if (this.slide.elapsedMs >= PUSH_STEP_MS) this.slide = null;
  }

  private slideSnapshot(): SlideSnapshot | null {
    const slide = this.slide;
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

  /** Single fixed tick. */
  tick(tickMs: number = TICK_MS) {
    // Independent of the player: a shoved object keeps travelling whatever
    // the player does next.
    this.tickSlide(tickMs);
    this.tickMotion(tickMs);
    // Last, and on every path through the tick: plates answer to the board the
    // tick leaves behind, not to any particular thing having caused it.
    this.settlePlatesNow();
  }

  /** The player's own motion for one tick — walking, falling, or starting to. */
  private tickMotion(tickMs: number) {
    if (this.fall) {
      this.tickFall(tickMs);
      return;
    }

    if (this.walk) {
      this.walk.elapsedMs += tickMs;
      if (this.walk.elapsedMs >= WALK_DURATION_MS) {
        this.commitWalk();
      } else {
        return;
      }
    }

    this.maybeStartFall();
    if (this.fall) return;

    this.maybeStartWalk();
  }

  getSnapshot(): GameSnapshot {
    const loc = this.player();
    // Include leftover accumulator so 60fps+ renders interpolate between 30Hz ticks.
    const visualExtra = this.accumulatorMs;
    return {
      map: this.map,
      player: {
        x: loc.x,
        y: loc.y,
        z: loc.z,
        stackIndex: loc.stackIndex,
        direction: playerDirection(loc),
      },
      walk: this.walk,
      fall: this.fall,
      walkProgress: this.walk
        ? Math.min(1, (this.walk.elapsedMs + visualExtra) / WALK_DURATION_MS)
        : 0,
      fallProgress: this.fall
        ? Math.min(1, (this.fall.elapsedMs + visualExtra) / FALL_MS_PER_HEIGHT)
        : 0,
      hover:
        this.hovered && this.canInteract(this.hovered) ? this.hovered : null,
      slide: this.slideSnapshot(),
    };
  }

  getMap(): MapFile {
    return this.map;
  }

  private playerDef(): TileDef {
    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) throw new Error(`Missing tile def "${PLAYER_TILE_ID}"`);
    return def;
  }

  private commitWalk() {
    const w = this.walk;
    if (!w) return;
    const loc = this.player();
    this.map = moveEntity(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      w.to,
      w.direction,
      this.tilesById,
    );
    this.walk = null;
  }

  private maybeStartWalk() {
    const dirs = this.input.directions;
    if (dirs.length === 0) return;

    const loc = this.player();
    const def = this.playerDef();
    const faceOnly = Boolean(this.input.faceOnly);
    const preferDescend = Boolean(this.input.preferDescend);

    for (let i = dirs.length - 1; i >= 0; i--) {
      const direction = dirs[i]!;

      this.map = setEntityDirection(
        this.map,
        loc.x,
        loc.y,
        loc.z,
        loc.stackIndex,
        direction,
      );

      if (faceOnly) return;

      const check = canWalk(
        this.map,
        {
          x: loc.x,
          y: loc.y,
          z: loc.z,
          stackIndex: loc.stackIndex,
        },
        direction,
        def,
        this.tilesById,
        { preferDescend },
      );

      if (!check.ok) continue;

      this.walk = {
        from: { x: loc.x, y: loc.y, z: loc.z },
        to: check.to,
        direction,
        elapsedMs: 0,
      };
      return;
    }
  }

  private maybeStartFall() {
    const def = this.playerDef();
    if (!def.affectedByGravity) return;

    const loc = this.player();
    if (
      isSupported(
        this.map,
        loc.x,
        loc.y,
        loc.z,
        loc.stackIndex,
        this.tilesById,
      )
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
    const landing = findLandingAbs(
      this.map,
      loc.x,
      loc.y,
      feetAbs,
      this.tilesById,
      { z: loc.z, stackIndex: loc.stackIndex },
    );
    if (landing == null || landing >= feetAbs) return;

    // Drops within climb height are step-downs (same as same-level height
    // change) — snap onto the surface instead of playing a fall.
    if (feetAbs - landing <= MAX_CLIMB_HEIGHT) {
      this.land(landing);
      return;
    }

    this.fall = {
      feetAbs,
      landingAbs: landing,
      elapsedMs: 0,
    };
  }

  private tickFall(tickMs: number) {
    if (!this.fall) return;
    this.fall.elapsedMs += tickMs;

    while (this.fall && this.fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
      this.fall.elapsedMs -= FALL_MS_PER_HEIGHT;
      this.stepFallOneHeight();
    }
  }

  private stepFallOneHeight() {
    if (!this.fall) return;

    const nextFeet = this.fall.feetAbs - 1;
    if (nextFeet <= this.fall.landingAbs) {
      this.land(this.fall.landingAbs);
      return;
    }

    this.fall.feetAbs = nextFeet;
    this.relocatePlayerToFeet(nextFeet);
  }

  private land(landingAbs: number) {
    this.fall = null;
    const loc = this.player();
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
      this.commitLandAt(landingAbs);
      const after = this.player();
      const facing = playerDirection(after);
      const slide = canWalk(
        this.map,
        {
          x: after.x,
          y: after.y,
          z: after.z,
          stackIndex: after.stackIndex,
        },
        facing,
        this.playerDef(),
        this.tilesById,
      );
      if (slide.ok) {
        this.walk = {
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
          this.commitLandAt(nextWalkable);
          return;
        }
        this.fall = {
          feetAbs,
          landingAbs: nextWalkable,
          elapsedMs: 0,
        };
        return;
      }
      return;
    }

    this.commitLandAt(landingAbs);
  }

  private commitLandAt(landingAbs: number) {
    const loc = this.player();
    const { z: targetZ } = cellForFeetAbs(landingAbs);
    const placed = { ...loc.placed };

    let next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

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

  private relocatePlayerToFeet(feetAbs: number) {
    const loc = this.player();
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
