import type { StateSprites, TileSprite } from "./types";

/**
 * Everything the pick needs to know about the tile doing the scattering.
 *
 * A `TileDef` is structurally one of these, so callers pass the def they
 * already hold — the same shape, and for the same reason, as
 * {@link AutotileIdentity} in `./autotile`. An id alone would let a caller drop
 * {@link TileDef.scatterSeed} on the floor and get a plausible, silently wrong
 * face back.
 */
export type ScatterIdentity = {
  id: string;
  scatterSeed?: number;
};

/**
 * Mixing constants, from the usual 32-bit avalanche families (the golden-ratio
 * word, and murmur3's finalizer). Nothing here is tuned to this game — they are
 * named only so the arithmetic below reads as a hash rather than as arithmetic.
 */
const X_MIX = 0x9e3779b1;
const Y_MIX = 0x85ebca6b;
const Z_MIX = 0xc2b2ae35;
const AVALANCHE_A = 0x2c1b3c6d;
const AVALANCHE_B = 0x297a2d39;
const HIGH_SHIFT = 15;
const LOW_SHIFT = 12;

/** FNV-1a's 32-bit offset basis and prime, for folding the tile id into a seed. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * A tile's id as a 32-bit number, so two scatter tiles on a default seed do not
 * agree with each other.
 *
 * Without it every scatter tile in the world shares seed 0, and a grass field
 * and a pebble field laid over the same cells pick the *same* index in every
 * one of them — visibly so, because the eye reads two independent scatters that
 * happen to correlate as a pattern. Folding the id in decorrelates them before
 * anybody has to know the seed control exists, and leaves the control meaning
 * what it says: re-roll *this* tile.
 */
function idSeed(id: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * A well-mixed 32-bit value for one cell.
 *
 * White noise on purpose: each cell is drawn independently of its neighbours,
 * which is what makes a brick road read as laid rather than as tiled. Anything
 * smoother — value noise, a repeating table — puts visible structure back into
 * the thing the type exists to remove.
 */
export function scatterHash(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  let h = Math.imul(seed | 0, X_MIX);
  h = Math.imul(h ^ (x | 0), X_MIX);
  h = Math.imul(h ^ (y | 0), Y_MIX);
  h = Math.imul(h ^ (z | 0), Z_MIX);
  h ^= h >>> HIGH_SHIFT;
  h = Math.imul(h, AVALANCHE_A);
  h ^= h >>> LOW_SHIFT;
  h = Math.imul(h, AVALANCHE_B);
  h ^= h >>> HIGH_SHIFT;
  return h >>> 0;
}

/**
 * Which face the placement at (x,y,z) wears, in `0..count-1`.
 *
 * Pure, and pure of the map above all — this is the one way a scatter tile
 * differs from an autotile, which cannot answer without reading its
 * neighbours. Nothing has to be re-picked when the cell beside it changes, so
 * an edit invalidates the cell it touched and no ring around it.
 */
export function resolveScatterIndex(
  x: number,
  y: number,
  z: number,
  tile: ScatterIdentity,
  count: number,
): number {
  if (count <= 1) return 0;
  const seed = (tile.scatterSeed ?? 0) ^ idSeed(tile.id);
  return scatterHash(x, y, z, seed) % count;
}

/**
 * Pick a TileSprite for a scatter tile: prefer the computed face, else the
 * first one authored.
 *
 * The fallback matters for the same reason the autotile one does — a state that
 * authors three faces where idle has five must still draw something for the
 * other two rather than going blank mid-walk.
 */
export function pickScatterSprite(
  /** Any sprite holder — a def for the idle state, a {@link StateSprites} for the rest. */
  tile: StateSprites,
  index: number,
): TileSprite | undefined {
  const variants = tile.scatter;
  if (!variants?.length) return undefined;
  return variants[index] ?? variants.find((s) => s != null);
}
