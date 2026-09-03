import { getStack } from "./mapData";
import {
  AUTOTILE_SLICE_COUNT,
  type AutotileSlice,
  type MapFile,
  type StateSprites,
  type TileSprite,
} from "./types";

/** Neighbor bit flags (blob / 8-neighbor). */
export const N = 1;
export const NE = 2;
export const E = 4;
export const SE = 8;
export const S = 16;
export const SW = 32;
export const W = 64;
export const NW = 128;

const EDGE_BITS = N | E | S | W;
const CORNER_BITS = NE | SE | SW | NW;

/**
 * Mask out corner bits when either adjacent edge is missing
 * (standard 47-tile blob rule).
 */
export function maskBlobCorners(raw: number): number {
  let mask = raw & (EDGE_BITS | CORNER_BITS);
  if (!(mask & N) || !(mask & E)) mask &= ~NE;
  if (!(mask & E) || !(mask & S)) mask &= ~SE;
  if (!(mask & S) || !(mask & W)) mask &= ~SW;
  if (!(mask & W) || !(mask & N)) mask &= ~NW;
  return mask;
}

/**
 * Dense lookup: masked 8-bit value → slice 0..46.
 * Built by enumerating all 256 raw masks, applying corner masking, and
 * assigning sequential ids to unique results (isolated = 0).
 */
const MASK_TO_SLICE: Uint8Array = (() => {
  const map = new Uint8Array(256);
  map.fill(255);
  const order: number[] = [];
  const seen = new Map<number, number>();

  // Prefer scanning in a stable order; ensure 0 (isolated) is slice 0.
  for (let raw = 0; raw < 256; raw++) {
    const masked = maskBlobCorners(raw);
    if (!seen.has(masked)) {
      seen.set(masked, order.length);
      order.push(masked);
    }
  }

  // Re-number so isolated (0) is index 0; keep relative order otherwise.
  const remap = new Map<number, number>();
  remap.set(0, 0);
  let next = 1;
  for (const m of order) {
    if (m === 0) continue;
    remap.set(m, next++);
  }

  for (let raw = 0; raw < 256; raw++) {
    const masked = maskBlobCorners(raw);
    map[raw] = remap.get(masked) ?? 0;
  }
  return map;
})();

/** One canonical bitmask per slice (for legends / previews). Slice 0 = isolated. */
export const AUTOTILE_SLICE_MASKS: readonly number[] = (() => {
  const masks = new Array<number>(AUTOTILE_SLICE_COUNT).fill(-1);
  for (let raw = 0; raw < 256; raw++) {
    const masked = maskBlobCorners(raw);
    const slice = MASK_TO_SLICE[raw]!;
    if (masks[slice]! < 0) masks[slice] = masked;
  }
  return masks;
})();

export function sliceRepresentativeMask(slice: AutotileSlice): number {
  return AUTOTILE_SLICE_MASKS[slice] ?? 0;
}

export function blobMaskToSlice(rawMask: number): AutotileSlice {
  return MASK_TO_SLICE[rawMask & 0xff] ?? 0;
}

/** Number of unique blob configurations (should be 47). */
export function blobSliceCount(): number {
  const uniq = new Set<number>();
  for (let i = 0; i < 256; i++) uniq.add(MASK_TO_SLICE[i]!);
  return uniq.size;
}

const NEIGHBOR_OFFSETS: { bit: number; dx: number; dy: number }[] = [
  { bit: N, dx: 0, dy: -1 },
  { bit: NE, dx: 1, dy: -1 },
  { bit: E, dx: 1, dy: 0 },
  { bit: SE, dx: 1, dy: 1 },
  { bit: S, dx: 0, dy: 1 },
  { bit: SW, dx: -1, dy: 1 },
  { bit: W, dx: -1, dy: 0 },
  { bit: NW, dx: -1, dy: -1 },
];

/**
 * Everything the mask needs to know about the tile doing the looking: its own
 * id, and whatever else it counts as itself.
 *
 * A `TileDef` is structurally one of these, so callers pass the def they
 * already hold. That is the point of taking an object rather than an id — the
 * two call sites both have the def, and an id alone is a signature that lets a
 * caller drop {@link TileDef.connectsTo} on the floor and get a plausible,
 * silently wrong slice back.
 */
export type AutotileIdentity = {
  id: string;
  connectsTo?: readonly string[];
};

/** True if the stack at (x,y,z) holds anything `tile` counts as itself. */
export function stackConnects(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tile: AutotileIdentity,
): boolean {
  return getStack(map, x, y, z).some(
    (p) => p.tileId === tile.id || tile.connectsTo?.includes(p.tileId) === true,
  );
}

/** Build 8-neighbor bitmask for an autotile placement. */
export function neighborMask(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tile: AutotileIdentity,
): number {
  let mask = 0;
  for (const { bit, dx, dy } of NEIGHBOR_OFFSETS) {
    if (stackConnects(map, x + dx, y + dy, z, tile)) mask |= bit;
  }
  return mask;
}

export function resolveAutotileSlice(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tile: AutotileIdentity,
): AutotileSlice {
  return blobMaskToSlice(neighborMask(map, x, y, z, tile));
}

/**
 * Pick a TileSprite for an autotile: prefer the computed slice, else isolated (0),
 * else the first defined slice.
 */
export function pickAutotileSprite(
  /** Any sprite holder — a def for the idle state, a {@link StateSprites} for the rest. */
  tile: StateSprites,
  slice: AutotileSlice,
): TileSprite | undefined {
  const slices = tile.slices;
  if (!slices) return undefined;
  const direct = slices[slice];
  if (direct) return direct;
  if (slices[0]) return slices[0];
  for (let i = 0; i < AUTOTILE_SLICE_COUNT; i++) {
    const s = slices[i];
    if (s) return s;
  }
  return undefined;
}
