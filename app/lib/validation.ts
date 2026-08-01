import type { MapFile, PlacedTile, TileDef } from "./types";
import { MAX_LEVEL, MIN_LEVEL, coordKey, levelKey } from "./types";
import { getStack, stackHeight } from "./mapData";

export type PlaceResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Can we append `tileDef` onto the existing stack at (x,y,z)?
 *
 * - e + h <= 4: always allowed
 * - 4 < e + h <= 8: only if (x,y,z+1) is empty and z < 8
 * - e + h > 8: rejected
 * - Also rejected if stack at (x,y,z-1) totals more than 4
 */
export function canPlace(
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

  // Space occupied from below?
  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    const belowH = stackHeight(below, tilesById);
    if (belowH > 4) {
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

  if (total <= 4) {
    return { ok: true };
  }

  if (total <= 8) {
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

  return { ok: false, reason: "Stack would exceed 8 height units" };
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
    if (belowH > 4 && newStack.length > 0) {
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
    const def = tilesById[placed.tileId];
    const h = def?.height ?? 0;
    e += h;
  }

  if (e <= 4) {
    return { ok: true };
  }

  if (e <= 8) {
    if (z >= MAX_LEVEL) {
      return { ok: false, reason: "Cannot overflow past the top level" };
    }
    // When replacing, we ignore our own old stack at z+1 check... wait, we check actual z+1.
    // If we're only replacing at z, z+1 must be empty for overflow.
    const above = getStack(map, x, y, z + 1);
    if (above.length > 0) {
      return {
        ok: false,
        reason: "Cannot overflow: level above is occupied",
      };
    }
    return { ok: true };
  }

  return { ok: false, reason: "Stack would exceed 8 height units" };
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
