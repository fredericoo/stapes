import type { FigureRig } from "./figure";

/** Written by `bun run fit:figure`, which fits every number here to the naked human in `people.png`. Edit by hand only to try a value before fitting again. */
export const FIGURE_RIG: FigureRig = {
  build: {
    headR: 1.22,
    headWidth: 1.06,
    headHeight: 0.78,
    torsoWidth: 1.45,
    torsoDepth: 0.8,
    legX: 0.6,
    legR: 0.62,
    footZ: 0.35,
    footR: 0.55,
    shoulderX: 2,
    armR: 0.55,
    handR: 0.45,
    lightX: -0.1,
    lightY: 0.63,
    highlightAbove: 0.49,
    shadowBelow: 0.26,
    underBodyZ: 0.6,
    coverage: 0.5,
  },
  facings: {
    s: {
      head: [0.07, 0.3, 5.56],
      poses: {
        stepA: {
          at: [0.24, -0.92],
          hipZ: 2.4,
          shoulderZ: 4.21,
          feet: [
            [-0.6, -0.9],
            [1.1, 0.9],
          ],
          elbows: [
            [-1.59, 0.13, 2.3],
            [2.35, -0.38, 3.15],
          ],
          hands: [
            [-1.46, 1, 1.45],
            [2.7, -0.76, 1.8],
          ],
        },
        stand: {
          at: [0.95, 0.5],
          hipZ: 2.2,
          shoulderZ: 4.35,
          feet: [
            [-1.34, 0.5],
            [0.6, 0.24],
          ],
          elbows: [
            [-2.2, 0, 3.05],
            [2.7, 0, 3.05],
          ],
          hands: [
            [-2.7, 0, 2.2],
            [2.95, -0.24, 2.2],
          ],
        },
        stepB: {
          at: [0.03, 0.67],
          hipZ: 3.46,
          shoulderZ: 4.56,
          feet: [
            [-1.1, 0.4],
            [0.1, -0.9],
          ],
          elbows: [
            [-2.35, -0.63, 2.65],
            [1.35, 1.13, 2.15],
          ],
          hands: [
            [-2.7, -1.26, 1.8],
            [2.7, 2.11, 1.56],
          ],
        },
      },
    },
    e: {
      head: [-0.5, -0.09, 5.54],
      poses: {
        stepA: {
          at: [-0.24, 0.5],
          hipZ: 2.45,
          shoulderZ: 3.1,
          feet: [
            [-0.6, -0.55],
            [0.1, 0.4],
          ],
          elbows: [
            [-1.85, 0.48, 2.65],
            [2.35, -0.63, 2.65],
          ],
          hands: [
            [-2.35, 1.26, 1.8],
            [2.7, -1.26, 1.8],
          ],
        },
        stand: {
          at: [0.24, -1.25],
          hipZ: 2.45,
          shoulderZ: 4.01,
          feet: [
            [-0.6, 0.41],
            [1.45, 0.35],
          ],
          elbows: [
            [-2.35, 0.5, 2.55],
            [2.35, 0.5, 3.05],
          ],
          hands: [
            [-2.2, 0, 2.2],
            [2.7, 0.5, 2.2],
          ],
        },
        stepB: {
          at: [-0.06, 0.4],
          hipZ: 2.3,
          shoulderZ: 3.2,
          feet: [
            [1.1, 1.25],
            [1.1, -0.9],
          ],
          elbows: [
            [-2.35, -0.28, 1.9],
            [2.35, 0.63, 2.65],
          ],
          hands: [
            [-2.45, -1.26, 1.3],
            [2.7, 0.76, 1.8],
          ],
        },
      },
    },
    w: {
      head: [0.33, -0.85, 6.2],
      poses: {
        stepA: {
          at: [-0.15, 1],
          hipZ: 2.8,
          shoulderZ: 3.95,
          feet: [
            [0.25, -1.14],
            [0.1, 0.4],
          ],
          elbows: [
            [-2.7, -1.34, 1.69],
            [1.15, -0.48, 2.3],
          ],
          hands: [
            [-2.7, 1.26, 1.8],
            [2.7, -1.61, 1.56],
          ],
        },
        stand: {
          at: [0.4, 0.65],
          hipZ: 1.7,
          shoulderZ: 4.35,
          feet: [
            [-1.1, -1],
            [0.54, -0.89],
          ],
          elbows: [
            [-2.35, 0, 3.05],
            [2.6, -0.5, 3.05],
          ],
          hands: [
            [-2.7, 0, 2.2],
            [2.2, 0, 2.2],
          ],
        },
        stepB: {
          at: [-1, 1.18],
          hipZ: 1.3,
          shoulderZ: 3.13,
          feet: [
            [-0.6, 0.4],
            [-0.4, -0.9],
          ],
          elbows: [
            [-1.39, -0.13, 2.3],
            [1.35, -0.72, 2.15],
          ],
          hands: [
            [-2.7, -0.76, 1.8],
            [1.7, 0.76, 1.8],
          ],
        },
      },
    },
    n: {
      head: [-0.56, -0.08, 5.58],
      poses: {
        stepA: {
          at: [-0.26, 0.85],
          hipZ: 1.3,
          shoulderZ: 4.41,
          feet: [
            [0.4, -1.14],
            [0.6, 0.9],
          ],
          elbows: [
            [-2.85, 0.02, 2.15],
            [2.68, -0.63, 2.65],
          ],
          hands: [
            [-2.7, 0.76, 1.8],
            [2.7, -1.26, 2.18],
          ],
        },
        stand: {
          at: [0.26, -0.6],
          hipZ: 0.78,
          shoulderZ: 3.1,
          feet: [
            [-0.27, 0],
            [0.6, 0],
          ],
          elbows: [
            [-2.85, 0.85, 3.05],
            [2.35, 0, 3.9],
          ],
          hands: [
            [-2.53, 0.5, 2.2],
            [2.7, 0.24, 2.2],
          ],
        },
        stepB: {
          at: [0.75, -0.25],
          hipZ: 1.8,
          shoulderZ: 4.17,
          feet: [
            [-0.6, 0.9],
            [-0.38, -0.65],
          ],
          elbows: [
            [-1.7, -1.13, 2.65],
            [2.35, 0.63, 2.65],
          ],
          hands: [
            [-2.45, -0.16, 1.8],
            [2.7, 1.26, 1.8],
          ],
        },
      },
    },
  },
};
