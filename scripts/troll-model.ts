import { type Bone, jointedLimbs } from "./jointed-limbs";
import type { Beast, Ellipsoid, LimbPoint, Mark, Pose, Tube } from "./quadruped-caster";

type TrollPart = "skin" | "belly" | "hide" | "hair" | "growth" | "face" | "nose" | "tusk" | "hand";

/** Short bowed legs under a body that is mostly trunk, on wide flat feet. */
const LEG_PLANTED: Bone[] = [
  [0, 4.4, 1.9],
  [0.6, 2.5, 1.5],
  [0, 0.9, 1.2],
  [1.3, 0.7, 1.2],
];
const LEG_FOLDED: Bone[] = [
  [0, 4.4, 1.9],
  [1.4, 3.0, 1.5],
  [0.5, 1.8, 1.2],
  [1.6, 1.8, 1.2],
];

/** Arms that reach the ground: the troll walks on its feet and trails its knuckles. */
const ARM_PLANTED: Bone[] = [
  [0, 8.6, 1.7],
  [-0.5, 5.8, 1.4],
  [0.5, 3.2, 1.3],
  [0.8, 2.0, 1.9],
];
const ARM_FOLDED: Bone[] = [
  [0, 8.6, 1.7],
  [-0.8, 6.0, 1.4],
  [0.9, 3.8, 1.3],
  [1.3, 2.7, 1.9],
];

const SIZE = 1;
const HIP_ACROSS = 2.1;
const LEGS = 2;

/** The cyclops's stride at the troll's shorter leg. */
const STRIDE = 1.6;
const ARM_SWING = 1.8;
const LANDING_LIFT = 0.3;
const PASSING = 0.4;
const POSES: Pose[] = [
  { swing: [0.3, -0.2, -0.3, 0.3], dropPx: 0, lifts: false },
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

const HEAD = "head";
const TAIL = "tail";

type Kind = {
  id: string;
  name: string;
  /** How wide the chest and shoulders are, as a share of the cave troll's. */
  breadth: number;
  /** How far the nose hangs out in front of the face. */
  nose: number;
  /** How far each ear sticks out sideways. */
  ear: number;
  /** What grows on the head, the hump and the back, drawn over the trunk. */
  growths: Ellipsoid<TrollPart>[];
  /** The tail in pieces, each a chain of joints; the first starts at the rump. */
  tail: { points: LimbPoint[]; part: TrollPart }[];
  eye: number;
  shade: Record<TrollPart, [number, number, number]>;
};

/**
 * The trunk, stooped: a hide round the hips, a pot belly, a broad chest
 * leaning forward under a hump, and a neckless head hung in front of the
 * shoulders. The face is a long drooping nose between two ears that stick out
 * sideways, over an underbite.
 */
function trunkOf({ breadth, nose, ear, growths }: Kind): Ellipsoid<TrollPart>[] {
  const shoulder = 3.7 * breadth;
  return [
    { part: "hide", at: [-0.2, 0, 4.9], radii: [2.4, 2.9, 1.7] },
    { part: "belly", at: [0.5, 0, 6.5], radii: [2.8, 3.2 * breadth, 2.4] },
    { part: "skin", at: [0.9, 0, 8.3], radii: [2.9, 3.8 * breadth, 2.5] },
    { part: "skin", at: [-0.5, 0, 9.6], radii: [2.6, 3.3 * breadth, 2.0] },
    { part: "skin", at: [0.6, shoulder, 8.8], radii: [1.9, 1.9, 1.9] },
    { part: "skin", at: [0.6, -shoulder, 8.8], radii: [1.9, 1.9, 1.9] },
    ...growths,
    { part: "skin", at: [2.6, 2.9 + ear, 11.2], radii: [0.7, ear, 0.8], group: HEAD },
    { part: "skin", at: [2.6, -2.9 - ear, 11.2], radii: [0.7, ear, 0.8], group: HEAD },
    { part: "skin", at: [3.0, 0, 10.6], radii: [2.9, 3.1, 2.7], marking: face, group: HEAD },
    { part: "skin", at: [4.4, 0, 8.8], radii: [1.7, 2.4, 1.0], group: HEAD },
    { part: "nose", at: [5.3 + nose / 2, 0, 10.1], radii: [nose, 0.9, 0.9], group: HEAD },
    { part: "tusk", at: [5.5, 1.9, 9.9], radii: [0.7, 0.7, 1.4], group: HEAD },
    { part: "tusk", at: [5.5, -1.9, 9.9], radii: [0.7, 0.7, 1.4], group: HEAD },
  ];
}

/**
 * The face is the part of the head that looks forward and a little up, so it
 * is tilted towards the viewer above and seen in every facing but north.
 */
function face(along: number, across: number, up: number): TrollPart | null {
  const forward = (along - 3.0) / 2.9;
  const raised = (up - 10.6) / 2.7;
  return 0.85 * forward + 0.35 * raised > 0.42 && Math.abs(across) < 2.6 ? "face" : null;
}

/** Two eyes under the brow. */
function faceOf({ eye }: Kind): Mark[] {
  return [
    { at: [4.8, 1.3, 12.4], index: eye, side: [1, 0.4, 0.2] },
    { at: [4.8, -1.3, 12.4], index: eye, side: [1, -0.4, 0.2] },
  ];
}

function troll(kind: Kind): Beast<TrollPart> {
  const limbs: [number, number][] = [
    [0, HIP_ACROSS],
    [0, -HIP_ACROSS],
    [0.8, 3.7 * kind.breadth + 1.3],
    [0.8, -3.7 * kind.breadth - 1.3],
  ];
  const tail = kind.tail;
  return {
    id: kind.id,
    name: kind.name,
    size: SIZE,
    topPx: 15,
    trunk: trunkOf(kind),
    legs: limbs,
    hipUp: 4.4,
    thigh: 1.9,
    knee: 1.5,
    foot: 1.2,
    footShare: 0.2,
    fur: "skin",
    footPart: "hand",
    stride: STRIDE,
    shade: (part, band) => kind.shade[part][band]!,
    marks: faceOf(kind),
    stepMs: 120,
    limb: jointedLimbs(
      limbs,
      LEGS,
      { planted: LEG_PLANTED, folded: LEG_FOLDED },
      { planted: ARM_PLANTED, folded: ARM_FOLDED },
    ),
    poses: POSES,
    walk: [1, 2, 3, 4],
    lines: 1.2,
    tubes: ({ dropPx }): Tube<TrollPart>[] =>
      tail.map(({ points, part }, piece) => ({
        points: points.map(({ at, r }, i) => ({
          at: [at[0], at[1], piece === 0 && i === 0 ? at[2] - dropPx / SIZE : at[2]],
          r,
        })),
        part: () => part,
        group: () => TAIL,
      })),
  };
}

/**
 * The fire troll, made of the cave it lives in: basalt-grey hide, the widest
 * of the three, with a ridge of live coals from its crown down its hump and
 * eyes the same orange. It breathes embers, so its belly is lit from inside.
 */
export const CAVE_TROLL = troll({
  id: "cave-troll",
  name: "Cave Troll",
  breadth: 1,
  nose: 1.0,
  ear: 0.9,
  growths: [
    { part: "growth", at: [1.6, 0, 13.3], radii: [1.1, 0.9, 0.8] },
    { part: "growth", at: [-1.0, 0, 11.6], radii: [1.2, 1.1, 0.9] },
    { part: "growth", at: [-2.6, 0, 10.0], radii: [1.0, 1.0, 0.9] },
    { part: "growth", at: [-2.9, 0, 8.0], radii: [0.9, 0.9, 0.9] },
    { part: "growth", at: [-1.2, 2.4, 10.8], radii: [0.8, 0.8, 0.7] },
    { part: "growth", at: [-1.2, -2.4, 10.8], radii: [0.8, 0.8, 0.7] },
  ],
  tail: [],
  eye: 17,
  shade: {
    skin: [22, 8, 4],
    belly: [25, 22, 8],
    hide: [4, 2, 0],
    hair: [4, 2, 0],
    growth: [19, 12, 9],
    face: [4, 2, 0],
    nose: [22, 8, 4],
    tusk: [28, 28, 27],
    hand: [8, 4, 2],
  },
});

/**
 * The water troll, a wader: narrower in the chest, blue-green with a pale
 * belly, finned ears, a fin from its crown down its back and a fish's tail
 * that curves down from the rump and lies flat on the ground, ending in a
 * forked fin.
 */
export const RIVER_TROLL = troll({
  id: "river-troll",
  name: "River Troll",
  breadth: 0.86,
  nose: 0.8,
  ear: 1.3,
  growths: [
    { part: "growth", at: [1.8, 0, 13.2], radii: [1.8, 0.45, 1.0] },
    { part: "growth", at: [-1.0, 0, 11.6], radii: [1.6, 0.45, 1.3] },
    { part: "growth", at: [-2.8, 0, 9.6], radii: [1.1, 0.45, 1.5] },
  ],
  tail: [
    {
      part: "skin",
      points: [
        { at: [-2.2, 0, 5.0], r: 1.4 },
        { at: [-3.6, 0, 2.6], r: 1.2 },
        { at: [-4.6, 0.2, 1.1], r: 1.0 },
        { at: [-6.4, 0.6, 0.8], r: 0.8 },
      ],
    },
    {
      part: "growth",
      points: [
        { at: [-6.4, 0.6, 0.7], r: 0.7 },
        { at: [-8.0, 2.0, 0.6], r: 0.6 },
      ],
    },
    {
      part: "growth",
      points: [
        { at: [-6.4, 0.6, 0.7], r: 0.7 },
        { at: [-8.2, -0.4, 0.6], r: 0.6 },
      ],
    },
  ],
  eye: 0,
  shade: {
    skin: [30, 24, 23],
    belly: [29, 30, 24],
    hide: [6, 5, 0],
    hair: [6, 5, 0],
    growth: [23, 31, 32],
    face: [28, 29, 30],
    nose: [24, 23, 5],
    tusk: [28, 28, 27],
    hand: [24, 23, 5],
  },
});

const BROWN: Kind["shade"] = {
  skin: [13, 11, 3],
  belly: [18, 13, 11],
  hide: [8, 4, 2],
  hair: [4, 2, 0],
  growth: [10, 9, 3],
  face: [18, 13, 11],
  nose: [11, 3, 2],
  tusk: [28, 28, 27],
  hand: [11, 3, 2],
};

const TUFTED_TAIL: Kind["tail"] = [
  {
    part: "skin",
    points: [
      { at: [-2.4, 0, 5.0], r: 0.8 },
      { at: [-4.2, 0, 3.4], r: 0.6 },
      { at: [-5.2, -0.4, 4.6], r: 0.6 },
    ],
  },
  {
    part: "hair",
    points: [
      { at: [-5.2, -0.4, 4.6], r: 0.6 },
      { at: [-5.6, -0.6, 5.8], r: 1.2 },
    ],
  },
];

/**
 * The plain troll, with no element, that the others are kinds of: brown,
 * with a shock of dark hair on its crown and down its neck, and a thin tail
 * with a tuft.
 */
export const TROLL = troll({
  id: "troll",
  name: "Troll",
  breadth: 0.94,
  nose: 1.3,
  ear: 1.1,
  growths: [
    { part: "hair", at: [1.6, 0, 12.8], radii: [1.8, 1.6, 1.0] },
    { part: "hair", at: [-0.6, 0, 11.6], radii: [1.5, 1.3, 1.0] },
  ],
  tail: TUFTED_TAIL,
  eye: 0,
  shade: BROWN,
});

/**
 * The nature troll, the one from the old forest pictures: the plain troll
 * with the longest nose, under a mane of moss over its head, hump and
 * shoulders with red-capped mushrooms growing in it.
 */
export const MOSS_TROLL = troll({
  id: "moss-troll",
  name: "Moss Troll",
  breadth: 0.94,
  nose: 1.5,
  ear: 1.1,
  growths: [
    { part: "hair", at: [1.4, 0, 12.2], radii: [2.6, 3.0, 1.5] },
    { part: "hair", at: [-1.0, 0, 10.6], radii: [2.6, 3.4, 1.8] },
    { part: "hair", at: [-2.4, 0, 8.6], radii: [1.7, 2.8, 2.2] },
    { part: "hair", at: [0, 3.6, 10.0], radii: [1.6, 1.6, 1.3] },
    { part: "hair", at: [0, -3.6, 10.0], radii: [1.6, 1.6, 1.3] },
    { part: "growth", at: [0.6, 1.4, 13.8], radii: [0.9, 0.9, 0.6] },
    { part: "growth", at: [-1.8, -1.6, 12.2], radii: [0.8, 0.8, 0.6] },
  ],
  tail: TUFTED_TAIL,
  eye: 0,
  shade: { ...BROWN, hair: [16, 15, 6] },
});

export const TROLLS = [CAVE_TROLL, TROLL, RIVER_TROLL, MOSS_TROLL];
