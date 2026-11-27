import type { Vec3 } from "./limb-caster";
import type { Beast, Ellipsoid, LimbPoint, Pose } from "./quadruped-caster";

type CyclopsPart = "skin" | "brow" | "hide" | "hair" | "eye" | "hand" | "foot";

/** A joint as [along from under the hip or shoulder, height above the ground, radius]. */
type Bone = [number, number, number];

/**
 * Short, thick, bowed legs: the thigh forward to a knee over the toes, the
 * shin back to the ankle, and a long flat foot. Folded mid-stride the knee
 * comes up and forward and the foot swings clear of the ground under it.
 */
const LEG_PLANTED: Bone[] = [
  [0, 7.4, 2.4],
  [0.8, 4.2, 1.8],
  [-0.1, 1.2, 1.4],
  [0.3, 0.7, 1.3],
  [1.6, 0.65, 1.25],
];
const LEG_FOLDED: Bone[] = [
  [0, 7.4, 2.4],
  [1.8, 4.8, 1.8],
  [0.6, 2.5, 1.4],
  [1.0, 2.1, 1.3],
  [2.0, 2.2, 1.25],
];

/**
 * Arms longer than the legs: the upper arm back and down from a high
 * shoulder, the forearm forward to a fist as big as the head, hanging by the
 * knee. Folded, the elbow bends a little more, which is all an arm does in
 * the stride.
 */
const ARM_PLANTED: Bone[] = [
  [0, 14.2, 2.1],
  [-0.6, 10.0, 1.8],
  [0.4, 6.2, 1.5],
  [0.6, 4.6, 2.3],
];
const ARM_FOLDED: Bone[] = [
  [0, 14.2, 2.1],
  [-0.9, 10.2, 1.8],
  [0.9, 6.8, 1.5],
  [1.2, 5.3, 2.3],
];

/** Right leg, left leg, right arm, left arm. */
const LIMBS: [number, number][] = [
  [0, 2.6],
  [0, -2.6],
  [1.2, 5.9],
  [1.2, -5.9],
];
const LEGS = 2;

/**
 * A limb's shape blends from planted to folded by its `lift`, then the whole
 * limb swings about its top joint by `swing`. The stride's drop squashes a
 * leg towards the ground, so a planted foot stays down while the body sinks,
 * and carries an arm down with the shoulder.
 */
function limb(index: number, pose: Pose, drop: number): LimbPoint[] {
  const [along, across] = LIMBS[index]!;
  const isLeg = index < LEGS;
  const planted = isLeg ? LEG_PLANTED : ARM_PLANTED;
  const folded = isLeg ? LEG_FOLDED : ARM_FOLDED;
  const t = pose.lift?.[index] ?? 0;
  const [rootAlong, rootUp] = planted[0]!;
  const angle = Math.atan2(pose.swing[index]!, rootUp);
  const squash = (rootUp - drop) / rootUp;
  return planted.map((bone, i) => {
    const other = folded[i]!;
    const dx = bone[0] + (other[0] - bone[0]) * t - rootAlong;
    const dz = bone[1] + (other[1] - bone[1]) * t - rootUp;
    const swungX = dx * Math.cos(angle) - dz * Math.sin(angle);
    const swungZ = dx * Math.sin(angle) + dz * Math.cos(angle);
    const up = isLeg ? (rootUp + swungZ) * squash : rootUp + swungZ - drop;
    const at: Vec3 = [along + rootAlong + swungX, across, up];
    return { at, r: bone[2], paw: i === planted.length - 1 };
  });
}

/**
 * A heavy stride: a foot lands ahead with the body a pixel lower, then passes
 * under it planted while the other leg swings through folded. Each arm swings
 * against the leg on its own side. The first frame stands, feet apart.
 */
const STRIDE = 2.2;
const ARM_SWING = 2.4;
const LANDING_LIFT = 0.3;
const PASSING = 0.5;
const POSES: Pose[] = [
  { swing: [0.4, -0.3, -0.4, 0.4], dropPx: 0, lifts: false },
  {
    swing: [STRIDE, -STRIDE, -ARM_SWING, ARM_SWING],
    lift: [0, LANDING_LIFT, 0, 0],
    dropPx: 1,
    lifts: true,
  },
  { swing: [-PASSING, PASSING, 0, 0], lift: [0, 1, 0.5, 0], dropPx: 0, lifts: true },
  {
    swing: [-STRIDE, STRIDE, ARM_SWING, -ARM_SWING],
    lift: [LANDING_LIFT, 0, 0, 0],
    dropPx: 1,
    lifts: true,
  },
  { swing: [PASSING, -PASSING, 0, 0], lift: [1, 0, 0, 0.5], dropPx: 0, lifts: true },
];

/** A hide strap slung from the right shoulder down across the chest to the left hip. */
function strap(_along: number, across: number, up: number): CyclopsPart | null {
  return Math.abs(across - (up - 12.5) * 1.1) < 0.7 ? "hide" : null;
}

const HEAD = "head";

/**
 * The trunk, hunched: a loincloth over the hips, a round belly, a barrel chest
 * leaning forward under a hump of shoulder muscle, and the head sunk low and
 * thrust out in front of it. The face is mostly one eye under a heavy brow,
 * over a wide jaw.
 */
const TRUNK: Ellipsoid<CyclopsPart>[] = [
  { part: "hide", at: [0, 0, 8.0], radii: [3.0, 3.6, 2.2] },
  { part: "skin", at: [0.6, 0, 10.2], radii: [3.4, 4.0, 3.2] },
  { part: "skin", at: [1.4, 0, 13.0], radii: [3.6, 4.8, 3.6], marking: strap },
  { part: "skin", at: [0.4, 0, 15.2], radii: [2.8, 4.2, 2.8] },
  { part: "skin", at: [1.0, 5.0, 14.2], radii: [2.5, 2.5, 2.5] },
  { part: "skin", at: [1.0, -5.0, 14.2], radii: [2.5, 2.5, 2.5] },
  { part: "hair", at: [3.0, 0, 17.4], radii: [1.4, 1.0, 0.9], group: HEAD },
  { part: "skin", at: [3.4, 2.0, 15.6], radii: [0.6, 0.6, 0.9], group: HEAD },
  { part: "skin", at: [3.4, -2.0, 15.6], radii: [0.6, 0.6, 0.9], group: HEAD },
  { part: "skin", at: [4.2, 0, 15.2], radii: [2.4, 2.2, 2.2], group: HEAD },
  { part: "skin", at: [5.2, 0, 13.8], radii: [1.3, 1.7, 0.9], group: HEAD },
  { part: "eye", at: [5.9, 0, 15.5], radii: [0.75, 1.5, 1.2], group: HEAD },
  { part: "brow", at: [5.7, 0, 16.6], radii: [0.9, 2.0, 0.7], group: HEAD },
];

/** The eye's blue iris, and two lower teeth showing at the front of the jaw. */
const MARKS: Beast<CyclopsPart>["marks"] = [
  { at: [6.6, 0, 15.5], index: 24, side: [1, 0, 0.2] },
  { at: [6.3, 0.55, 13.5], index: 28, side: [1, 0.3, 0] },
  { at: [6.3, -0.55, 13.5], index: 28, side: [1, -0.3, 0] },
];

/**
 * A cave giant with one eye: a hulking, hunched body on short bowed legs,
 * arms longer than the legs ending in fists as big as its head, and a small
 * head carried low between the shoulders. Warm tan skin with a deep
 * red-brown shadow, so its muscle reads in the dark of the deep way and the
 * cold blue of the eye stands out, a hide loincloth and a strap across the
 * chest. A line is drawn wherever an arm, a leg or the head passes in front
 * of the body.
 */
export const CYCLOPS: Beast<CyclopsPart> = {
  id: "cyclops",
  name: "Cyclops",
  size: 1,
  topPx: 20,
  trunk: TRUNK,
  legs: LIMBS,
  hipUp: 7.4,
  thigh: 2,
  knee: 1.5,
  foot: 1.2,
  footShare: 0.2,
  fur: "skin",
  footPart: "hand",
  stride: STRIDE,
  shade: (part, band) => {
    if (part === "eye") return [28, 27, 25][band]!;
    if (part === "hide") return [8, 4, 2][band]!;
    if (part === "hair") return [4, 2, 2][band]!;
    if (part === "brow") return [11, 3, 3][band]!;
    if (part === "hand" || part === "foot") return [11, 3, 2][band]!;
    return [18, 11, 3][band]!;
  },
  marks: MARKS,
  stepMs: 120,
  limb,
  poses: POSES,
  walk: [1, 2, 3, 4],
  lines: 0.6,
  frame: { cells: 6, base: 4 },
};
