import type { MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
} from "./types";
import { getStack, stackHeight } from "./mapData";

export type PlaceResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Can `tileDef` sit on top of the stack at (x,y,z)?
 * Generic fit check (not player-specific) — same rules as editor placement.
 *
 * - Feet must be within this level: e < HEIGHT_PER_LEVEL. A full stack already
 *   reaches the next level; place there instead (clean floor).
 * - e + h <= HEIGHT_PER_LEVEL: always allowed
 * - HEIGHT_PER_LEVEL < e + h <= 2*HEIGHT_PER_LEVEL: only if (x,y,z+1) is empty
 *   and z < MAX_LEVEL (e.g. full-height on a half-height base)
 * - e + h > 2*HEIGHT_PER_LEVEL: rejected
 * - Also rejected if stack at (x,y,z-1) totals more than HEIGHT_PER_LEVEL
 */
export function fitsTile(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
): PlaceResult {
  if (z < MIN_LEVEL || z > MAX_LEVEL) {
    return { ok: false, reason: "Level out of range" };
  }

  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    const belowH = stackHeight(below, tilesById);
    if (belowH > HEIGHT_PER_LEVEL) {
      return {
        ok: false,
        reason: "Space occupied by overflow from the level below",
      };
    }
  }

  const stack = getStack(map, x, y, z);
  const e = stackHeight(stack, tilesById);
  const h = tileDef.height;
  const total = e + h;

  if (e >= HEIGHT_PER_LEVEL) {
    return {
      ok: false,
      reason: "Stack already reaches the next level; place there instead",
    };
  }

  if (total <= HEIGHT_PER_LEVEL) {
    return { ok: true };
  }

  if (total <= HEIGHT_PER_LEVEL * 2) {
    if (z >= MAX_LEVEL) {
      return { ok: false, reason: "Cannot overflow past the top level" };
    }
    const above = getStack(map, x, y, z + 1);
    if (above.length > 0) {
      return {
        ok: false,
        reason: "Cannot overflow: level above is occupied",
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Stack would exceed ${HEIGHT_PER_LEVEL * 2} height units`,
  };
}

/** Can we append `tileDef` onto the existing stack at (x,y,z)? */
export function canPlace(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
): PlaceResult {
  return fitsTile(map, x, y, z, tileDef, tilesById);
}

/**
 * Can `tileDef` stand with feet at absolute elevation `feetAbs` in column (x,y)?
 * Uses volume clearance (works on top of overflowing stacks where {@link fitsTile}
 * would reject because the level above is “occupied” by overflow).
 *
 * Height-0 tiles act as a floor plate / ceiling at the level base.
 */
export function fitsAtElevation(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
): PlaceResult {
  const headAbs = feetAbs + tileDef.height;
  const maxAbs = (MAX_LEVEL + 1) * HEIGHT_PER_LEVEL + HEIGHT_PER_LEVEL;
  if (feetAbs < MIN_LEVEL * HEIGHT_PER_LEVEL || headAbs > maxAbs) {
    return { ok: false, reason: "Out of vertical range" };
  }

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const stack = getStack(map, x, y, z);
    if (stack.length === 0) continue;
    const h = stackHeight(stack, tilesById);
    const volLo = z * HEIGHT_PER_LEVEL;
    const volHi = volLo + h;

    if (h === 0) {
      // Floor plate: blocks entering this level from below.
      if (feetAbs < volLo && headAbs > volLo) {
        return { ok: false, reason: "Blocked by floor/ceiling above" };
      }
      continue;
    }

    // Standing exactly on top (volHi === feetAbs) does not intersect.
    if (volLo < headAbs && volHi > feetAbs) {
      return { ok: false, reason: "Blocked by solid in standing space" };
    }
  }

  return { ok: true };
}

/**
 * Can we replace the entire stack at (x,y,z) with `newStack`?
 * Validates the whole stack as if built from empty, plus overflow/below rules.
 */
export function canReplaceStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  newStack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): PlaceResult {
  if (z < MIN_LEVEL || z > MAX_LEVEL) {
    return { ok: false, reason: "Level out of range" };
  }

  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    const belowH = stackHeight(below, tilesById);
    if (belowH > HEIGHT_PER_LEVEL && newStack.length > 0) {
      return {
        ok: false,
        reason: "Space occupied by overflow from the level below",
      };
    }
  }

  // Empty is always fine (and frees overflow for the level below).
  if (newStack.length === 0) {
    return { ok: true };
  }

  let e = 0;
  for (const placed of newStack) {
    if (e >= HEIGHT_PER_LEVEL) {
      return {
        ok: false,
        reason: "Stack already reaches the next level; place there instead",
      };
    }
    const def = tilesById[placed.tileId];
    const h = def?.height ?? 0;
    e += h;
  }

  if (e <= HEIGHT_PER_LEVEL) {
    return { ok: true };
  }

  if (e <= HEIGHT_PER_LEVEL * 2) {
    if (z >= MAX_LEVEL) {
      return { ok: false, reason: "Cannot overflow past the top level" };
    }
    const above = getStack(map, x, y, z + 1);
    if (above.length > 0) {
      return {
        ok: false,
        reason: "Cannot overflow: level above is occupied",
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Stack would exceed ${HEIGHT_PER_LEVEL * 2} height units`,
  };
}

export function tilesByIdFromList(tiles: TileDef[]): Record<string, TileDef> {
  const out: Record<string, TileDef> = {};
  for (const t of tiles) out[t.id] = t;
  return out;
}

/** Debug helper: ensure empty stacks aren't stored. */
export function assertNoEmptyStacks(map: MapFile): void {
  for (const level of Object.values(map.levels)) {
    for (const [key, stack] of Object.entries(level)) {
      if (stack.length === 0) {
        throw new Error(`Empty stack stored at ${key}`);
      }
    }
  }
}

export { coordKey, levelKey };
