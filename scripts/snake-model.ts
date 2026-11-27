import type { Vec3 } from "./limb-caster";
import type { Beast, Ellipsoid, LimbPoint, Mark, Pose, Tube } from "./quadruped-caster";

type SnakePart = "scales" | "band" | "head" | "hood" | "throat";

const STEP = 0.75;

/** The neck swings less than the body, so the head stays on course while the body winds behind it. */
const NECK_SWAY = 0.35;
const NECK_SETTLES = 4;

type SnakeSpec = {
  id: string;
  name: string;
  size: number;
  topPx: number;
  /** From the neck back to the tip of the tail, in model units along the body. */
  length: number;
  /** Where the neck sits, ahead of the middle of the cell, so the whole snake is centred on it. */
  neckAlong: number;
  /** The body's radius at its thickest, a third of the way down. */
  girth: number;
  /** The head's size against the snake's own one, which is wider than its neck. */
  headScale: number;
  /** One S-bend of the body every this many units, and how far it swings to either side. */
  wavelength: number;
  sway: number;
  /** How high the head is held standing and slithering, and how much of the neck rises with it. */
  rearRaise: number;
  slitherRaise: number;
  rearLength: number;
  /** Which stretch of the body, counted in `STEP`s from the neck, is drawn as `band`. */
  banded: (segment: number) => boolean;
  /** A cobra's hood, spread either side of the neck while it rears. */
  hood: boolean;
  shade: (part: SnakePart, band: number) => number;
  eye: number;
  stepMs: number;
};

/** Thickest a third of the way down at `girth`, from a narrower neck, tapering to a point. */
function radiusAt(spec: SnakeSpec, u: number): number {
  const thickest = (spec.length * 4) / 15;
  const scale = spec.girth / 1.1;
  if (u < thickest) return scale * (0.8 + 0.3 * (u / thickest));
  return scale * (1.1 - 0.8 * ((u - thickest) / (spec.length - thickest)));
}

/** How far the body is raised off the ground at `u`: only the neck lifts, as far as `raise` at the head. */
function liftAt(spec: SnakeSpec, u: number, raise: number): number {
  const fade = Math.max(0, 1 - u / spec.rearLength);
  return raise * fade * fade;
}

function spineAt(spec: SnakeSpec, u: number, pose: Pose): Vec3 {
  const phase = (pose.phase ?? 0) * 2 * Math.PI;
  const sway = spec.sway * (NECK_SWAY + (1 - NECK_SWAY) * Math.min(1, u / NECK_SETTLES));
  const across = sway * Math.sin((2 * Math.PI * u) / spec.wavelength - phase);
  return [spec.neckAlong - u, across, radiusAt(spec, u) + liftAt(spec, u, pose.raise ?? 0)];
}

/**
 * The body as a tube along a wave. A phase further on moves every bend
 * towards the tail, which is how a snake's body travels back along itself as
 * it slides forward.
 */
function body(spec: SnakeSpec, pose: Pose): Tube<SnakePart>[] {
  const points: LimbPoint[] = [];
  for (let u = 0; u <= spec.length; u += STEP) {
    points.push({ at: spineAt(spec, u, pose), r: radiusAt(spec, u) });
  }
  return [
    {
      points,
      part: (segment) => (spec.banded(segment) ? "band" : "scales"),
      group: (segment) => `body ${segment}`,
    },
  ];
}

/** A flat, wedge-shaped head with a rounded snout, and a cobra's hood behind it while it rears. */
function head(spec: SnakeSpec, pose: Pose): Ellipsoid<SnakePart>[] {
  const [along, across, up] = spineAt(spec, 0, pose);
  const k = spec.headScale;
  const parts: Ellipsoid<SnakePart>[] = [
    {
      part: "head",
      at: [along + 1.2 * k, across, up],
      radii: [1.4 * k, 1.15 * k, 0.8 * k],
      group: "head",
    },
    {
      part: "head",
      at: [along + 2.3 * k, across, up - 0.15 * k],
      radii: [0.75 * k, 0.75 * k, 0.55 * k],
      group: "head",
    },
  ];
  if (!spec.hood) return parts;
  const spread = pose.phase === undefined ? 1 : 0.55;
  const [neckAlong, neckAcross, neckUp] = spineAt(spec, 1.1, pose);
  return [
    {
      part: "hood",
      at: [neckAlong, neckAcross, neckUp],
      radii: [0.55, 1.15 + 0.95 * spread, 1.0 + 0.7 * spread],
      marking: (a) => (a > neckAlong + 0.25 ? "throat" : null),
      group: "hood",
    },
    ...parts,
  ];
}

/** Eyes on either side of the head, and a tongue out while it stands and tastes the air. */
function marks(spec: SnakeSpec, pose: Pose): Mark[] {
  const [along, across, up] = spineAt(spec, 0, pose);
  const k = spec.headScale;
  const eyes: Mark[] = [
    {
      at: [along + 1.7 * k, across + 0.75 * k, up + 0.35 * k],
      index: spec.eye,
      side: [0.3, 1, 0.5],
    },
    {
      at: [along + 1.7 * k, across - 0.75 * k, up + 0.35 * k],
      index: spec.eye,
      side: [0.3, -1, 0.5],
    },
  ];
  if (pose.phase !== undefined) return eyes;
  const tongue: Mark[] = [3.3, 4.0].map((ahead) => ({
    at: [along + ahead * k, across, up - 0.2 * k],
    index: 10,
    side: [0, 0, 1],
    free: true,
  }));
  return [...eyes, ...tongue];
}

const STILL = { swing: [0, 0, 0, 0] as [number, number, number, number], dropPx: 0, lifts: false };

/**
 * Standing, a snake holds its head up with its tongue out. Four frames of
 * the slither follow, each a quarter of a wave on, with the head kept low.
 */
function snakeBeast(spec: SnakeSpec): Beast<SnakePart> {
  return {
    id: spec.id,
    name: spec.name,
    size: spec.size,
    topPx: spec.topPx,
    trunk: (pose) => head(spec, pose),
    tubes: (pose) => body(spec, pose),
    legs: [],
    hipUp: 0,
    thigh: 0,
    knee: 0,
    foot: 0,
    footShare: 0,
    fur: "scales",
    footPart: "scales",
    stride: 0,
    shade: spec.shade,
    marks: (pose) => marks(spec, pose),
    stepMs: spec.stepMs,
    poses: [
      { ...STILL, raise: spec.rearRaise },
      ...[0, 0.25, 0.5, 0.75].map((phase) => ({ ...STILL, phase, raise: spec.slitherRaise })),
    ],
    walk: [1, 2, 3, 4],
    lines: 1.5,
  };
}

/** A dark band across the back every other stretch of this many units. */
function bandsEvery(units: number) {
  return (segment: number) => Math.floor((segment * STEP) / units) % 2 === 1;
}

/**
 * A green snake, smaller and as skinny as the hand-drawn one it replaced: a
 * round body thicker a third of the way down, narrowing at the neck and
 * tapering to the tail, banded dark across the back, under a flat head held a
 * little off the ground. The body's shadow stops at the mid green, since the
 * darkest is too near the outline on a body this thin.
 */
export const SNAKE = snakeBeast({
  id: "snake",
  name: "Snake",
  size: 0.8,
  topPx: 5,
  length: 15,
  neckAlong: 5.5,
  girth: 1.1,
  headScale: 1,
  wavelength: 9,
  sway: 1.6,
  rearRaise: 1.6,
  slitherRaise: 0.5,
  rearLength: 2.5,
  banded: bandsEvery(1.5),
  hood: false,
  shade: (part, band) => {
    if (part === "band") return [16, 6, 6][band]!;
    return [20, 16, 16][band]!;
  },
  eye: 19,
  stepMs: 110,
});

/**
 * A sand-coloured cobra, longer than the snake, with dark rings down its back.
 * Standing, it rears the front of its body up and spreads a hood either side
 * of the neck, pale at the throat; slithering, the hood folds half back.
 */
export const COBRA = snakeBeast({
  id: "cobra",
  name: "Cobra",
  size: 0.85,
  topPx: 10,
  length: 17,
  neckAlong: 6,
  girth: 1.15,
  headScale: 1,
  wavelength: 10,
  sway: 1.7,
  rearRaise: 6,
  slitherRaise: 0.8,
  rearLength: 5,
  banded: bandsEvery(2.25),
  hood: true,
  shade: (part, band) => {
    if (part === "band") return [11, 3, 3][band]!;
    if (part === "throat") return [18, 18, 13][band]!;
    if (part === "hood") return [13, 11, 3][band]!;
    return [19, 18, 13][band]!;
  },
  eye: 0,
  stepMs: 110,
});

/** Irregular dark blotches down the back, two or three steps long with gaps between them. */
const BLOTCHES = [2, 3, 5, 6, 9, 10, 11, 14, 15, 18, 19, 20, 23, 24, 27];

/**
 * An anaconda, a quarter longer than the snake and twice as thick, olive with
 * black blotches, under a head barely wider than its neck.
 * It keeps its head low even standing: it waits in the water, not reared up.
 */
export const ANACONDA = snakeBeast({
  id: "anaconda",
  name: "Anaconda",
  size: 1,
  topPx: 9,
  length: 15,
  neckAlong: 5.5,
  girth: 2.3,
  headScale: 1.35,
  wavelength: 10,
  sway: 2,
  rearRaise: 1.4,
  slitherRaise: 0.4,
  rearLength: 3.5,
  banded: (segment) => BLOTCHES.includes(segment),
  hood: false,
  shade: (part, band) => {
    if (part === "band") return [1, 0, 0][band]!;
    if (part === "head") return [16, 6, 6][band]!;
    return [16, 6, 1][band]!;
  },
  eye: 21,
  stepMs: 140,
});
