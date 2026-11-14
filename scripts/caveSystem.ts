import type { Direction } from "../app/lib/types";

export const SYSTEM = {
  levels: [-1, -2, -3] as const,
  seeds: [0x5ea11ce, 0x7b04e57, 0xcabe770] as const,

  mouth: { x: 10, y: 20 },
  mouthDescent: "s" as Direction,

  rockChance: { open: 0.5, dense: 0.66 },

  rampsPerTransition: 14,
  rampSpacing: 14,

  pitsPerFloor: [10, 10, 0],

  population: [
    { rat: 32, wolf: 0, "cave-troll": 0 },
    { rat: 40, wolf: 11, "cave-troll": 0 },
    { rat: 50, wolf: 20, "cave-troll": 1 },
  ] as ReadonlyArray<Readonly<Record<string, number>>>,

  cellsPerCrystal: 190,
} as const;

/**
 * Holes in the surface drawn with the `hole` tile: a shaft beside a ladder, and
 * a hole in a house floor over its cellar. Daylight through them is meant, as it
 * is through the mouth, so the sky checks treat them as openings too.
 */
export const AUTHORED_HOLES = [
  { x: -2, y: 31 },
  { x: 55, y: -12 },
] as const;
