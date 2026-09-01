import {
  absoluteStandingElevation,
  absoluteWalkableElevation,
  appendTile,
  getStack,
  isPlayerBody,
  listCoords,
  stackHeight,
  walkableFloorAbove,
} from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { placeEntityOnSurface, removeEntity } from "./mapMutations";
import { sceneryStack, standingAbs } from "./movement";

/**
 * True when the entity has solid underfoot:
 * - another tile below it on the same stack, or
 * - the level below is full (≥ HEIGHT_PER_LEVEL), forming a floor.
 */
export function isSupported(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): boolean {
  // Anything below in the stack holds this up, except a person: two players in
  // one cell stand on the same floor rather than on each other, so a body under
  // your feet is not a reason to stop falling. @see ../lib/mapData isPlayerBody
  const stack = getStack(map, x, y, z);
  for (let i = 0; i < stackIndex; i++) {
    if (!isPlayerBody(stack[i]!)) return true;
  }

  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    if (stackHeight(below, tilesById) >= HEIGHT_PER_LEVEL) return true;
  }

  return false;
}

/**
 * Highest solid surface absolute elevation strictly below `feetAbs` at (x,y).
 * Includes non-walkable tops (caller may slide or fall through).
 * Returns null if nothing is below (open void).
 */
export function findLandingAbs(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tilesById: Record<string, TileDef>,
  /** Stack index of falling entity at its current cell, if on this column. */
  exclude?: { z: number; stackIndex: number },
): number | null {
  let best: number | null = null;

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = sceneryStack(map, x, y, z, exclude.stackIndex);
    }

    if (stack.some((placed) => !isPlayerBody(placed))) {
      const top = absoluteStandingElevation(z, stack, tilesById);
      if (top < feetAbs) {
        best = best == null ? top : Math.max(best, top);
      }
    }

    // Full stack below forms a floor at the base of this level.
    if (z > MIN_LEVEL) {
      let below = getStack(map, x, y, z - 1);
      if (exclude && exclude.z === z - 1) {
        below = sceneryStack(map, x, y, z - 1, exclude.stackIndex);
      }
      if (stackHeight(below, tilesById) >= HEIGHT_PER_LEVEL) {
        const floorAbs = z * HEIGHT_PER_LEVEL;
        if (floorAbs < feetAbs) {
          best = best == null ? floorAbs : Math.max(best, floorAbs);
        }
      }
    }
  }

  return best;
}

/**
 * Highest walkable surface absolute elevation strictly below `feetAbs`.
 * Skips non-walkable solid tops (fall-through after a failed slide).
 */
export function findWalkableLandingAbs(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): number | null {
  let best: number | null = null;

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = sceneryStack(map, x, y, z, exclude.stackIndex);
    }

    if (stack.length > 0) {
      const walkAbs = absoluteWalkableElevation(z, stack, tilesById);
      if (walkAbs != null && walkAbs < feetAbs) {
        best = best == null ? walkAbs : Math.max(best, walkAbs);
      }
    }

    if (z > MIN_LEVEL) {
      let below = getStack(map, x, y, z - 1);
      if (exclude && exclude.z === z - 1) {
        below = sceneryStack(map, x, y, z - 1, exclude.stackIndex);
      }
      const floorAbs = walkableFloorAbove(z - 1, below, tilesById);
      if (floorAbs != null && floorAbs < feetAbs) {
        best = best == null ? floorAbs : Math.max(best, floorAbs);
      }
    }
  }

  return best;
}

/**
 * A body the settle pass should drop, as opposed to one a runtime is driving.
 *
 * The only thing that keeps an unsupported gravity tile off the settle pass is
 * something *already* animating its fall — an actor, which carries an `owner`.
 * That is not the old actor/scenery divide by another name: a box and a deer
 * both obey gravity, and the sole difference here is who plays the animation. A
 * body with a runtime plays its own; everything else the board drops for it.
 */
function isLooseGravityBody(
  placed: PlacedTile | undefined,
  tilesById: Record<string, TileDef>,
): boolean {
  if (!placed || placed.owner) return false;
  return tilesById[placed.tileId]?.affectedByGravity === true;
}

/** Does any placement in this cell fall under the board's own gravity? */
export function cellHasLooseGravity(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) =>
    isLooseGravityBody(placed, tilesById),
  );
}

/**
 * Every cell holding a gravity body no runtime drives. Whole-map scan, for
 * building the index once at load rather than per tick.
 */
export function findLooseGravityCells(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasLooseGravity(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

export type GravityResult = {
  map: MapFile;
  /** Cells whose stack changed — a body left one and joined another. */
  changed: Coord[];
};

/**
 * Drop every unsupported gravity body in `cells` onto whatever is beneath it.
 *
 * The counterpart to an actor's animated fall, for bodies with no runtime to
 * animate one: it snaps rather than plays, so a crate whose floor is pulled
 * lands on the frame the floor goes rather than hanging in the air like a
 * broken switch. Run before plates settle, so a body that drops onto a plate
 * presses it the same tick.
 *
 * A body only ever falls from the base of its level — anything sitting on top of
 * something is supported by definition — so a single drop takes it straight to
 * its landing rather than one height unit at a time. A stack of them collapses
 * over successive settles, on the same next-tick convergence plates settle
 * under.
 */
export function settleGravity(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
): GravityResult {
  const changed: Coord[] = [];
  let next = map;

  for (const cell of cells) {
    const placed = getStack(next, cell.x, cell.y, cell.z)[0];
    if (!isLooseGravityBody(placed, tilesById)) continue;
    if (isSupported(next, cell.x, cell.y, cell.z, 0, tilesById)) continue;

    const feetAbs = standingAbs(next, cell.x, cell.y, cell.z, 0, tilesById);
    const landing = findLandingAbs(next, cell.x, cell.y, feetAbs, tilesById, {
      z: cell.z,
      stackIndex: 0,
    });
    // Nothing underneath, or nothing lower than it already stands: an object
    // over the void has nowhere to fall, exactly as it does for an actor.
    if (landing == null || landing >= feetAbs) continue;

    const body = { ...placed! };
    const { z: destZ } = cellForFeetAbs(landing);
    next = removeEntity(next, cell.x, cell.y, cell.z, 0);

    const destStack = getStack(next, cell.x, cell.y, destZ);
    const destTop = absoluteStandingElevation(destZ, destStack, tilesById);
    next =
      destStack.length > 0 && destTop === landing
        ? placeEntityOnSurface(next, cell.x, cell.y, destZ, body, tilesById)
        : appendTile(next, cell.x, cell.y, destZ, body);

    changed.push({ ...cell });
    changed.push({ x: cell.x, y: cell.y, z: destZ });
  }

  return { map: next, changed };
}

/** Map cell where an entity with feet at `feetAbs` should be stored. */
export function cellForFeetAbs(
  feetAbs: number,
): { z: number; elevInLevel: number } {
  let z = Math.floor(feetAbs / HEIGHT_PER_LEVEL);
  let elev = feetAbs - z * HEIGHT_PER_LEVEL;
  if (z < MIN_LEVEL) {
    elev += (MIN_LEVEL - z) * HEIGHT_PER_LEVEL;
    z = MIN_LEVEL;
  }
  if (z > MAX_LEVEL) {
    elev += (z - MAX_LEVEL) * HEIGHT_PER_LEVEL;
    z = MAX_LEVEL;
  }
  return { z, elevInLevel: elev };
}
