import type { Transition } from "../lib/tileTransition";

export const RATING_UP_EFFECT: Transition = {
  durationMs: 1_200,
  particles: {
    ratePerSecond: 140,
    ttlFromMs: 700,
    ttlToMs: 1_300,
    spawnRadiusCells: 0.45,
    spawnElevFrom: 0,
    spawnElevTo: 2,
    riseFrom: 4,
    riseTo: 9,
    driftCellsPerSecond: 0.3,
    lit: false,
    ownDepth: true,
    gravity: -4,
    offsetX: "",
    offsetY: "",
    offsetElev: "",
    shape: ["..#..", "..#..", "#####", "..#..", "..#.."],
    sizeFromPx: 5,
    sizeToPx: 2,
    radiusFromPx: 1,
    radiusToPx: 1,
    alphaFrom: 1,
    alphaTo: 0,
    ramp: [
      { at: 0, color: "#fffbe0" },
      { at: 0.4, color: "#ffd23f" },
      { at: 1, color: "#d9822b" },
    ],
  },
};
