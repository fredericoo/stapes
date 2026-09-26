import type { StateSprites, TileSprite } from "./types";

export type ScatterIdentity = {
  id: string;
  scatterSeed?: number;
};

const X_MIX = 0x9e3779b1;
const Y_MIX = 0x85ebca6b;
const Z_MIX = 0xc2b2ae35;
const AVALANCHE_A = 0x2c1b3c6d;
const AVALANCHE_B = 0x297a2d39;
const HIGH_SHIFT = 15;
const LOW_SHIFT = 12;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function idSeed(id: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), FNV_PRIME);
  }
  return h >>> 0;
}

export function scatterHash(x: number, y: number, z: number, seed: number): number {
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

export function pickScatterSprite(tile: StateSprites, index: number): TileSprite | undefined {
  const variants = tile.scatter;
  if (!variants?.length) return undefined;
  return variants[index] ?? variants.find((s) => s != null);
}
