import {
  type Beast,
  type Bone,
  type Frame,
  type Mark,
  jointedLimb,
  trotPoses,
} from "./quadruped-caster";

type DeerPart = "coat" | "back" | "pale" | "tail" | "ear" | "nose" | "leg" | "hoof";

/**
 * A hind leg: a heavy thigh forward and down to the stifle, a long shin back
 * to a hock held well off the ground, and a thin cannon bone straight down
 * to the hoof. Folded mid-swing the hock rises and the hoof hangs under it.
 */
const HIND_PLANTED: Bone[] = [
  [0, 5.6, 1.0],
  [0.9, 4, 0.85],
  [-0.9, 2.4, 0.7],
  [-0.5, 0.5, 0.7],
  [-0.1, 0.3, 0.7],
];
const HIND_FOLDED: Bone[] = [
  [0, 5.6, 1.0],
  [1.4, 4.1, 0.85],
  [-0.9, 3.2, 0.7],
  [0.1, 1.8, 0.7],
  [0.5, 1.5, 0.7],
];

/**
 * A foreleg: straight from the shoulder through the knee to the hoof, far
 * thinner below the knee than above. Folded mid-swing the knee comes forward
 * and the cannon bone tucks back under it.
 */
const FRONT_PLANTED: Bone[] = [
  [0.2, 5.7, 0.9],
  [-0.2, 4, 0.75],
  [0, 2.1, 0.7],
  [0, 0.5, 0.7],
  [0.3, 0.3, 0.7],
];
const FRONT_FOLDED: Bone[] = [
  [0.2, 5.7, 0.9],
  [-0.2, 4.1, 0.75],
  [0.9, 2.9, 0.7],
  [-0.1, 2.1, 0.7],
  [-0.6, 2, 0.7],
];

/** Front right, front left, hind right, hind left. */
const LEGS: [number, number][] = [
  [2.8, 1.5],
  [2.8, -1.5],
  [-3.8, 1.5],
  [-3.8, -1.5],
];

const STRIDE = 1.5;

const FRAME: Frame = { cells: 5, base: 3 };

const ANTLER = 27;
const EYE = 0;

type Point = [number, number, number];

/**
 * One antler, thinner than the cast can draw: a single spike from behind the
 * brow that leans well out to the side. Branches and tines turn to noise at
 * this size.
 */
const ANTLER_BASE: Point = [5.8, 0.8, 11.7];
const ANTLER_TIP: Point = [5.4, 3.6, 14.6];

/** Marks every third of a pixel from `a` to `b`, so the pixels they land on join up. */
function line(a: Point, b: Point, side: number): Mark[] {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 3);
  return Array.from({ length: steps + 1 }, (_, i): Mark => {
    const t = i / steps;
    const at = (n: 0 | 1 | 2) => a[n] + (b[n] - a[n]) * t;
    return {
      at: [at(0), at(1) * side, at(2)],
      index: ANTLER,
      side: [0, 0, 1],
      free: true,
      edged: true,
    };
  });
}

const ANTLERS: Mark[] = [1, -1].flatMap((side) => line(ANTLER_BASE, ANTLER_TIP, side));

/** How much longer the deer is drawn facing the viewer; judged by eye against the west and north frames. */
const TOWARDS_VIEWER_STRETCH = 1.4;

/**
 * A red deer stag: a level back on thin legs, a deep chest that tucks up
 * to a lean flank, a neck that reaches up and forward to a head carried above the
 * shoulders, big ears out to the sides and antlers above them. The coat is
 * russet with a darker line down the back, and the belly, the throat, the
 * rump patch and the short tail are pale.
 */
export const DEER: Beast<DeerPart> = {
  id: "deer",
  name: "Deer",
  size: 0.7,
  topPx: 15,
  frame: FRAME,
  trunk: [
    { part: "tail", at: [-5.5, 0, 7.3], radii: [0.6, 0.6, 0.9], group: "tail" },
    {
      part: "coat",
      at: [-3.3, 0, 7],
      radii: [2.1, 2.0, 1.8],
      marking: (along, _across, up) => (along < -4.6 && up < 7.7 ? "pale" : null),
    },
    {
      part: "coat",
      at: [-0.8, 0, 7.1],
      radii: [2.6, 1.95, 1.8],
      marking: (_along, across, up) =>
        up > 8.4 && Math.abs(across) < 0.8 ? "back" : up < 5.8 ? "pale" : null,
    },
    {
      part: "coat",
      at: [1.9, 0, 7],
      radii: [2.3, 2.0, 2.0],
      marking: (_along, _across, up) => (up < 5.7 ? "pale" : null),
    },
    { part: "coat", at: [3.9, 0, 8.3], radii: [1.4, 1.15, 1.5] },
    {
      part: "coat",
      at: [5.0, 0, 9.5],
      radii: [1.2, 0.95, 1.4],
      marking: (along, _across, up) => (along > 5.4 && up < 9.7 ? "pale" : null),
    },
    { part: "coat", at: [6.1, 0, 10.7], radii: [1.4, 1.2, 1.2] },
    { part: "ear", at: [5.3, -1.6, 11.4], radii: [0.5, 0.8, 0.5] },
    { part: "ear", at: [5.3, 1.6, 11.4], radii: [0.5, 0.8, 0.5] },
    { part: "coat", at: [7.5, 0, 10.1], radii: [1.3, 0.75, 0.75] },
    { part: "nose", at: [8.6, 0, 10], radii: [0.45, 0.45, 0.45] },
  ],
  legs: LEGS,
  hipUp: 5.6,
  thigh: 1.3,
  knee: 0.7,
  foot: 0.5,
  footShare: 0.15,
  fur: "leg",
  footPart: "hoof",
  stride: STRIDE,
  shade: (part, band) => {
    if (part === "nose" || part === "hoof") return 0;
    if (part === "pale" || part === "tail") return [28, 27, 25][band]!;
    if (part === "back") return [11, 11, 3][band]!;
    if (part === "ear") return [13, 11, 3][band]!;
    if (part === "leg") return [13, 11, 11][band]!;
    return [18, 13, 11][band]!;
  },
  marks: [
    { at: [6.9, 0.85, 10.9], index: EYE, side: [0.5, 1, 0.4] },
    { at: [6.9, -0.85, 10.9], index: EYE, side: [0.5, -1, 0.4] },
    ...ANTLERS,
  ],
  stepMs: 85,
  limb: jointedLimb(LEGS, {
    front: { planted: FRONT_PLANTED, folded: FRONT_FOLDED },
    hind: { planted: HIND_PLANTED, folded: HIND_FOLDED },
  }),
  poses: trotPoses(STRIDE, [1.1, -1.1, -1.1, 1.1]),
  walk: [1, 2, 3, 4],
  stretch: { s: TOWARDS_VIEWER_STRETCH, e: TOWARDS_VIEWER_STRETCH },
  lines: 1,
};
