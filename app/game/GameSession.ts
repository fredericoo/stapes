import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isWalkableSurfaceAt,
} from "../lib/mapData";
import { isInteractive, resolveDrag } from "../lib/interactions";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { MIN_LEVEL, coordKey } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { DragTargets } from "./drag";
import { reachableDragTargets } from "./drag";
import {
  DRAG_STEP_MS,
  FALL_MS_PER_HEIGHT,
  MAX_CLIMB_HEIGHT,
  PLAYER_TILE_ID,
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
import { playerDirection, requireSinglePlayer } from "./player";

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

export type DragSnapshot = {
  object: ObjectRef;
  /** `coordKey`s of every cell this drag can reach. */
  targetKeys: string[];
  /** Cell the pointer is over, legal or not. */
  pointer: { x: number; y: number } | null;
  /** Where the object would come to rest, or null when the pointer is illegal. */
  target: Coord | null;
};

/** A dropped object travelling to where it was dragged, one tile at a time. */
export type SlideSnapshot = {
  object: ObjectRef;
  from: Coord;
  to: Coord;
  /** 0–1 through the current tile. */
  progress: number;
};

export type GameSnapshot = {
  map: MapFile;
  player: Coord & { stackIndex: number; direction: Direction };
  walk: WalkState | null;
  fall: FallState | null;
  walkProgress: number;
  fallProgress: number;
  /** Interactive object under the pointer, if any. */
  hover: ObjectRef | null;
  drag: DragSnapshot | null;
  slide: SlideSnapshot | null;
};

/**
 * Reach in tiles, measured as a square around the player — diagonals count,
 * so anything in the ring of 8 cells touching them is grabbable.
 */
const GRAB_REACH_TILES = 1;

type DragState = {
  object: ObjectRef;
  targets: DragTargets;
  pointer: { x: number; y: number } | null;
};

/**
 * A released drag in flight. The object is committed one cell at a time so the
 * map is always a legal state mid-slide, and the renderer lerps between them.
 */
type SlideState = {
  /** Where the object sits right now — updated on every committed step. */
  object: ObjectRef;
  /** Remaining cells to travel through, in order. */
  remaining: Coord[];
  from: Coord;
  elapsedMs: number;
};

/**
 * Authoritative play session. Mutates an in-memory map; no DOM / renderer.
 */
export class GameSession {
  private map: MapFile;
  private readonly tilesById: Record<string, TileDef>;
  private input: GameInput = { directions: [] };
  private walk: WalkState | null = null;
  private fall: FallState | null = null;
  private accumulatorMs = 0;
  private hovered: ObjectRef | null = null;
  private drag: DragState | null = null;
  private slide: SlideState | null = null;

  constructor(map: MapFile, tiles: TileDef[]) {
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);
    requireSinglePlayer(this.map);
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
   * Objects on any other level are invisible to the pointer — the player only
   * reaches into the plane they are standing on.
   */
  private interactiveDefAt(ref: ObjectRef): TileDef | null {
    const loc = requireSinglePlayer(this.map);
    if (ref.z !== loc.z) return null;
    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    if (!placed) return null;
    const def = this.tilesById[placed.tileId];
    if (!def || !isInteractive(def)) return null;
    return def;
  }

  /** Within arm's reach: any of the 8 cells touching the player, diagonals included. */
  private withinReach(ref: ObjectRef): boolean {
    const loc = requireSinglePlayer(this.map);
    const dx = Math.abs(ref.x - loc.x);
    const dy = Math.abs(ref.y - loc.y);
    const rings = Math.max(dx, dy);
    return rings > 0 && rings <= GRAB_REACH_TILES;
  }

  /**
   * Can the player start dragging this object right now? Hover outlines every
   * interactive object on the level as an affordance, but only objects in reach
   * can actually be acted on.
   */
  canGrab(ref: ObjectRef): boolean {
    if (this.drag || this.slide || this.walk || this.fall) return false;
    const def = this.interactiveDefAt(ref);
    return Boolean(def && resolveDrag(def) && this.withinReach(ref));
  }

  /** Renderer reports what the pointer is over; the session decides if it counts. */
  setHoveredObject(ref: ObjectRef | null) {
    this.hovered = ref && this.interactiveDefAt(ref) ? ref : null;
  }

  /** Start dragging an object. Returns false when the player cannot reach it. */
  beginDrag(ref: ObjectRef): boolean {
    if (!this.canGrab(ref)) return false;
    const def = this.interactiveDefAt(ref);
    const drag = def && resolveDrag(def);
    if (!def || !drag) return false;

    this.drag = {
      object: ref,
      targets: reachableDragTargets(this.map, ref, def, drag, this.tilesById),
      pointer: null,
    };
    return true;
  }

  /** Cell the pointer is over mid-drag, in the object's own level plane. */
  setDragPointer(cell: { x: number; y: number } | null) {
    if (!this.drag) return;
    this.drag.pointer = cell;
  }

  /** Drop the object if the pointer is on a reachable cell; otherwise put it back. */
  endDrag() {
    const active = this.drag;
    this.drag = null;
    if (!active?.pointer) return;

    const target = active.targets.get(
      coordKey(active.pointer.x, active.pointer.y),
    );
    if (!target || target.path.length === 0) return;

    // Travels the path it was cleared for rather than teleporting; each cell
    // is committed as it is reached, so the map is never in a halfway state.
    this.slide = {
      object: active.object,
      remaining: [...target.path],
      from: { x: active.object.x, y: active.object.y, z: active.object.z },
      elapsedMs: 0,
    };
    // The outline rides along with it.
    this.hovered = active.object;
  }

  cancelDrag() {
    this.drag = null;
  }

  isDragging(): boolean {
    return this.drag != null;
  }

  private tickSlide(tickMs: number) {
    const slide = this.slide;
    if (!slide) return;

    slide.elapsedMs += tickMs;
    while (this.slide && this.slide.elapsedMs >= DRAG_STEP_MS) {
      this.slide.elapsedMs -= DRAG_STEP_MS;
      this.commitSlideStep();
    }
  }

  private commitSlideStep() {
    const slide = this.slide;
    if (!slide) return;

    const next = slide.remaining.shift();
    if (!next) {
      this.slide = null;
      return;
    }

    this.map = moveEntity(this.map, slide.object, next, undefined, this.tilesById);
    const landed = {
      ...next,
      stackIndex: getStack(this.map, next.x, next.y, next.z).length - 1,
    };
    slide.object = landed;
    slide.from = { x: next.x, y: next.y, z: next.z };
    if (this.hovered) this.hovered = landed;

    if (slide.remaining.length === 0) this.slide = null;
  }

  private slideSnapshot(): SlideSnapshot | null {
    const slide = this.slide;
    const to = slide?.remaining[0];
    if (!slide || !to) return null;
    return {
      object: slide.object,
      from: slide.from,
      to,
      progress: Math.min(
        1,
        (slide.elapsedMs + this.accumulatorMs) / DRAG_STEP_MS,
      ),
    };
  }

  /** Single fixed tick. */
  tick(tickMs: number = TICK_MS) {
    // Anything that moves the player invalidates the reach the drag was
    // computed against, so physics wins and the grab is released.
    if (this.drag && this.fall) this.drag = null;

    // Independent of the player: a released object keeps travelling whatever
    // the player does next.
    this.tickSlide(tickMs);

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
    const loc = requireSinglePlayer(this.map);
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
      hover: this.hovered,
      drag: this.dragSnapshot(),
      slide: this.slideSnapshot(),
    };
  }

  private dragSnapshot(): DragSnapshot | null {
    const active = this.drag;
    if (!active) return null;
    const pointer = active.pointer;
    return {
      object: active.object,
      targetKeys: [...active.targets.keys()],
      pointer,
      target: pointer
        ? active.targets.get(coordKey(pointer.x, pointer.y))?.to ?? null
        : null,
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
    const loc = requireSinglePlayer(this.map);
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
    // Hands are busy — walking away mid-drag would break the reach the drag
    // targets were computed from.
    if (this.drag) return;

    const dirs = this.input.directions;
    if (dirs.length === 0) return;

    const loc = requireSinglePlayer(this.map);
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

    const loc = requireSinglePlayer(this.map);
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
    const loc = requireSinglePlayer(this.map);
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
      const after = requireSinglePlayer(this.map);
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
    const loc = requireSinglePlayer(this.map);
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
    const loc = requireSinglePlayer(this.map);
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
