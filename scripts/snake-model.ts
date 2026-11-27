import type { Vec3 } from "./limb-caster";
import type { Beast, Ellipsoid, LimbPoint, Mark, Pose, Tube } from "./quadruped-caster";

type SnakePart = "scales" | "band" | "head";

/** From the neck back to the tip of the tail, in model units along the body. */
const LENGTH = 15;
const STEP = 0.75;
/** Where the neck sits, ahead of the middle of the cell, so the whole snake is centred on it. */
const NECK_ALONG = 5.5;

/** One S-bend of the body every this many units, and how far it swings to either side. */
const WAVELENGTH = 9;
const SWAY = 1.6;
/** The neck swings less than the body, so the head stays on course while the body winds behind it. */
const NECK_SWAY = 0.35;
const NECK_SETTLES = 4;

/** A dark band across the back every other stretch of this length. */
const BAND = 1.5;

/** Thickest a third of the way down, from a narrower neck, tapering to a point. */
function radiusAt(u: number): number {
  const thickest = 4;
  if (u < thickest) return 0.8 + 0.3 * (u / thickest);
  return 1.1 - 0.8 * ((u - thickest) / (LENGTH - thickest));
}

/** How far the body is raised off the ground at `u`: only the neck lifts, as far as `raise` at the head. */
function liftAt(u: number, raise: number): number {
  const fade = Math.max(0, 1 - u / 2.5);
  return raise * fade * fade;
}

function spineAt(u: number, pose: Pose): Vec3 {
  const phase = (pose.phase ?? 0) * 2 * Math.PI;
  const sway = SWAY * (NECK_SWAY + (1 - NECK_SWAY) * Math.min(1, u / NECK_SETTLES));
  const across = sway * Math.sin((2 * Math.PI * u) / WAVELENGTH - phase);
  return [NECK_ALONG - u, across, radiusAt(u) + liftAt(u, pose.raise ?? 0)];
}

/**
 * The body as a tube along a wave. A phase further on moves every bend
 * towards the tail, which is how a snake's body travels back along itself as
 * it slides forward.
 */
function body(pose: Pose): Tube<SnakePart>[] {
  const points: LimbPoint[] = [];
  for (let u = 0; u <= LENGTH; u += STEP) points.push({ at: spineAt(u, pose), r: radiusAt(u) });
  return [
    {
      points,
      part: (segment) => (Math.floor((segment * STEP) / BAND) % 2 === 1 ? "band" : "scales"),
      group: (segment) => `body ${segment}`,
    },
  ];
}

/** A flat, wedge-shaped head, wider than the neck, with a rounded snout. */
function head(pose: Pose): Ellipsoid<SnakePart>[] {
  const [along, across, up] = spineAt(0, pose);
  return [
    { part: "head", at: [along + 1.2, across, up], radii: [1.4, 1.15, 0.8], group: "head" },
    {
      part: "head",
      at: [along + 2.3, across, up - 0.15],
      radii: [0.75, 0.75, 0.55],
      group: "head",
    },
  ];
}

/** Gold eyes on either side of the head, and a tongue out while it stands and tastes the air. */
function marks(pose: Pose): Mark[] {
  const [along, across, up] = spineAt(0, pose);
  const eyes: Mark[] = [
    { at: [along + 1.7, across + 0.75, up + 0.35], index: 19, side: [0.3, 1, 0.5] },
    { at: [along + 1.7, across - 0.75, up + 0.35], index: 19, side: [0.3, -1, 0.5] },
  ];
  if (pose.phase !== undefined) return eyes;
  const tongue: Mark[] = [3.3, 4.0].map((ahead) => ({
    at: [along + ahead, across, up - 0.2],
    index: 10,
    side: [0, 0, 1],
    free: true,
  }));
  return [...eyes, ...tongue];
}

const STILL = { swing: [0, 0, 0, 0] as [number, number, number, number], dropPx: 0, lifts: false };

/**
 * Standing, the snake holds its head up with its tongue out. Four frames of
 * the slither follow, each a quarter of a wave on, with the head kept low.
 */
const POSES: Pose[] = [
  { ...STILL, raise: 1.6 },
  ...[0, 0.25, 0.5, 0.75].map((phase) => ({ ...STILL, phase, raise: 0.5 })),
];

/**
 * A green snake, smaller and as skinny as the hand-drawn one it replaces: a round body
 * thicker a third of the way down, narrowing at the neck and tapering to the
 * tail, banded dark across the back, under a flat head held a little off the
 * ground. The body's shadow stops at the mid green, since the darkest is too
 * near the outline on a body this thin.
 */
export const SNAKE: Beast<SnakePart> = {
  id: "snake",
  name: "Snake",
  size: 0.8,
  topPx: 5,
  trunk: head,
  tubes: body,
  legs: [],
  hipUp: 0,
  thigh: 0,
  knee: 0,
  foot: 0,
  footShare: 0,
  fur: "scales",
  footPart: "scales",
  stride: 0,
  shade: (part, band) => {
    if (part === "band") return [16, 6, 6][band]!;
    return [20, 16, 16][band]!;
  },
  marks,
  stepMs: 110,
  poses: POSES,
  walk: [1, 2, 3, 4],
  lines: 1.5,
};
