import type { Vec3 } from "./limb-caster";
import type { Beast, LimbPoint, Pose } from "./quadruped-caster";

type WolfPart = "coat" | "saddle" | "pale" | "tip" | "nose" | "leg" | "paw";

/** Palette indices, each ramp lit, mid and dark. */
export type WolfColours = {
  coat: [number, number, number];
  saddle: [number, number, number];
  pale: [number, number, number];
  leg: [number, number, number];
  eye: number;
};

const saddleAbove =
  (up: number) =>
  (_along: number, _across: number, at: number): WolfPart | null =>
    at > up ? "saddle" : null;

const paleBelow =
  (up: number) =>
  (_along: number, _across: number, at: number): WolfPart | null =>
    at < up ? "pale" : null;

/** A joint as [along from under the hip or shoulder, height above the ground, radius]. */
type Bone = [number, number, number];

/**
 * A hind leg zig-zags: the thigh runs forward and down from the hip to the
 * stifle, the shin back and down to a hock held well off the ground, and the
 * long rear foot nearly straight down to the paw. Folded mid-swing the hock
 * rises and the foot swings forward under it.
 */
const HIND_PLANTED: Bone[] = [
  [0, 5.6, 1.2],
  [0.9, 3.8, 0.75],
  [-0.6, 2.0, 0.5],
  [-0.35, 0.5, 0.48],
  [0.35, 0.45, 0.5],
];
const HIND_FOLDED: Bone[] = [
  [0, 5.6, 1.2],
  [1.3, 4.0, 0.75],
  [-0.7, 3.0, 0.5],
  [0.1, 1.7, 0.48],
  [0.5, 1.3, 0.5],
];

/**
 * A foreleg runs back from the shoulder to the elbow, then nearly straight
 * down through the wrist to a short pastern and the paw. Folded mid-swing the
 * wrist bends and the paw tucks back under it.
 */
const FRONT_PLANTED: Bone[] = [
  [0.2, 6.0, 1.05],
  [-0.45, 4.0, 0.65],
  [-0.15, 1.3, 0.5],
  [0.05, 0.5, 0.48],
  [0.6, 0.45, 0.5],
];
const FRONT_FOLDED: Bone[] = [
  [0.2, 6.0, 1.05],
  [-0.5, 4.2, 0.65],
  [0.2, 2.4, 0.5],
  [-0.4, 1.7, 0.48],
  [-0.9, 1.9, 0.5],
];

/** Front right, front left, hind right, hind left: shoulders over the ribcage, hips under the croup. */
const LEGS: [number, number][] = [
  [1.9, 1.0],
  [1.9, -1.0],
  [-3.1, 1.0],
  [-3.1, -1.0],
];

/**
 * The leg's shape blends from planted to folded by its `lift`, then the whole
 * leg swings about its top joint so the paw lands `swing` ahead. The walk's
 * drop squashes it towards the ground, so a planted paw stays down while the
 * body sinks.
 */
function limb(leg: number, pose: Pose, drop: number): LimbPoint[] {
  const [along, across] = LEGS[leg]!;
  const front = leg < 2;
  const planted = front ? FRONT_PLANTED : HIND_PLANTED;
  const folded = front ? FRONT_FOLDED : HIND_FOLDED;
  const t = pose.lift?.[leg] ?? 0;
  const [rootAlong, rootUp] = planted[0]!;
  const angle = Math.atan2(pose.swing[leg]!, rootUp);
  const squash = (rootUp - drop) / rootUp;
  return planted.map((bone, i) => {
    const other = folded[i]!;
    const dx = bone[0] + (other[0] - bone[0]) * t - rootAlong;
    const dz = bone[1] + (other[1] - bone[1]) * t - rootUp;
    const swungX = dx * Math.cos(angle) - dz * Math.sin(angle);
    const swungZ = dx * Math.sin(angle) + dz * Math.cos(angle);
    const at: Vec3 = [along + rootAlong + swungX, across, (rootUp + swungZ) * squash];
    return { at, r: bone[2], paw: i === planted.length - 1 };
  });
}

/**
 * A trot: each diagonal pair lands ahead together, then passes under the body
 * planted while the other pair swings through folded. The body is a pixel
 * lower on the landings. The first frame stands, a little staggered.
 */
const STRIDE = 1.5;
const LANDING_LIFT = 0.3;
const PASSING = 0.4;
const POSES: Pose[] = [
  { swing: [0.4, -0.2, -0.3, 0.2], dropPx: 0, lifts: false },
  {
    swing: [STRIDE, -STRIDE, -STRIDE, STRIDE],
    lift: [0, LANDING_LIFT, LANDING_LIFT, 0],
    dropPx: 1,
    lifts: true,
  },
  { swing: [-PASSING, PASSING, PASSING, -PASSING], lift: [0, 1, 1, 0], dropPx: 0, lifts: true },
  {
    swing: [-STRIDE, STRIDE, STRIDE, -STRIDE],
    lift: [LANDING_LIFT, 0, 0, LANDING_LIFT],
    dropPx: 1,
    lifts: true,
  },
  { swing: [PASSING, -PASSING, -PASSING, PASSING], lift: [1, 0, 0, 1], dropPx: 0, lifts: true },
];

/** How much longer the wolf is drawn facing the viewer; judged by eye against the west and north frames. */
const TOWARDS_VIEWER_STRETCH = 1.5;

/**
 * A grey wolf: a deep ribcage under high shoulder blades, a loin that tucks up
 * to a lean croup, a thick neck and cheek ruff, a broad skull with a brow,
 * short pointed ears and a solid muzzle, and a bushy tail carried back. A
 * slimmer body, taller legs and a long thin muzzle read as a fox at this
 * size. The back is a darker saddle and the cheeks, chest and jaw pale.
 */
export function wolfBeast(id: string, name: string, colours: WolfColours): Beast<WolfPart> {
  return {
    id,
    name,
    size: 1,
    topPx: 13,
    trunk: [
      { part: "tip", at: [-7.8, 0, 3.8], radii: [0.75, 0.75, 0.75] },
      { part: "coat", at: [-6.9, 0, 4.4], radii: [1.2, 1.05, 1.0], marking: saddleAbove(5.2) },
      { part: "coat", at: [-5.9, 0, 5.2], radii: [1.2, 1.05, 1.05], marking: saddleAbove(6.0) },
      { part: "coat", at: [-4.8, 0, 6.0], radii: [0.9, 0.8, 0.8], marking: saddleAbove(6.5) },
      { part: "coat", at: [-3.3, 0, 6.2], radii: [1.7, 1.6, 1.5], marking: saddleAbove(7.1) },
      { part: "coat", at: [-1.2, 0, 6.5], radii: [1.9, 1.5, 1.2], marking: saddleAbove(7.3) },
      {
        part: "coat",
        at: [1.0, 0, 6.1],
        radii: [2.2, 2.0, 2.0],
        marking: (along, _across, up) =>
          up > 7.6 ? "saddle" : along > 2.4 && up < 6.0 ? "pale" : null,
      },
      { part: "saddle", at: [2.0, 0, 7.4], radii: [1.3, 1.7, 1.0] },
      { part: "coat", at: [3.4, 0, 7.6], radii: [1.4, 1.6, 1.6], marking: paleBelow(6.8) },
      { part: "coat", at: [3.9, -0.9, 7.9], radii: [1.0, 0.9, 1.1], marking: paleBelow(7.6) },
      { part: "coat", at: [3.9, 0.9, 7.9], radii: [1.0, 0.9, 1.1], marking: paleBelow(7.6) },
      { part: "coat", at: [4.8, 0, 8.5], radii: [1.3, 1.25, 1.15] },
      { part: "coat", at: [5.4, 0, 8.9], radii: [0.6, 1.0, 0.5] },
      { part: "saddle", at: [4.3, -0.85, 9.5], radii: [0.55, 0.45, 0.6] },
      { part: "saddle", at: [4.3, 0.85, 9.5], radii: [0.55, 0.45, 0.6] },
      { part: "saddle", at: [4.2, -0.9, 10.2], radii: [0.3, 0.25, 0.45] },
      { part: "saddle", at: [4.2, 0.9, 10.2], radii: [0.3, 0.25, 0.45] },
      { part: "pale", at: [5.9, 0, 7.5], radii: [1.0, 0.55, 0.4] },
      { part: "coat", at: [6.1, 0, 8.0], radii: [1.2, 0.72, 0.72], marking: paleBelow(7.8) },
      { part: "nose", at: [7.2, 0, 8.15], radii: [0.38, 0.38, 0.38] },
    ],
    legs: LEGS,
    hipUp: 6,
    thigh: 1.2,
    knee: 0.65,
    foot: 0.5,
    footShare: 0.15,
    fur: "leg",
    footPart: "paw",
    stride: STRIDE,
    shade: (part, band) => {
      if (part === "nose" || part === "paw") return 0;
      if (part === "tip") return colours.saddle[2];
      return colours[part][band]!;
    },
    marks: [
      { at: [5.6, 0.7, 8.6], index: colours.eye, side: [0.5, 1, 0.4] },
      { at: [5.6, -0.7, 8.6], index: colours.eye, side: [0.5, -1, 0.4] },
    ],
    stepMs: 70,
    limb,
    poses: POSES,
    walk: [1, 2, 3, 4],
    stretch: { s: TOWARDS_VIEWER_STRETCH, e: TOWARDS_VIEWER_STRETCH },
  };
}
