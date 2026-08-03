import {
  absoluteStandingElevation,
  absoluteWalkableElevation,
  getStack,
  stackHeight,
} from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { sceneryStack } from "./movement";

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
  if (stackIndex > 0) return true;

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

    if (stack.length > 0) {
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
