import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import { normalise, type Vec3 } from "./limb-caster";
import { castModel, writeCast } from "./model-caster";
import { paint, paletteRgba, writeTileset } from "./tileset-output";

const TILESET_ID = "forest-beasts";

/** Four cells square with the beast standing on the third, so its snout, tail and lean all fit. */
const FRAME_CELLS = 4;
const BASE_CELL = 2;
const FRAME_PX = FRAME_CELLS * CELL_SIZE;
const OUTLINE = 0;

type Facing = "n" | "e" | "s" | "w";
const FACINGS: Facing[] = ["s", "n", "e", "w"];

/** The way a facing looks on the ground: x is east and y is south. */
const AHEAD: Record<Facing, [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};

/** Along the beast, across it to its right, and up, from the middle of its cell on the ground, in pixels before `size`. */
type Ellipsoid<P extends string> = {
  part: P;
  at: Vec3;
  radii: Vec3;
  /** Repaints a point of this ellipsoid as another part, for markings that follow the body. */
  marking?: (along: number, across: number, up: number) => P | null;
};

type Pose = { swing: [number, number, number, number]; dropPx: number; lifts: boolean };

type Hit<P extends string> = { part: P; normal: Vec3 };

type Beast<P extends string> = {
  id: string;
  name: string;
  /** The model, marks included, is drawn this many times larger; the walk still sinks it by a whole pixel. */
  size: number;
  topPx: number;
  trunk: Ellipsoid<P>[];
  /** Front right, front left, hind right, hind left. */
  legs: [number, number][];
  hipUp: number;
  thigh: number;
  knee: number;
  foot: number;
  /** How much of the lower leg, from the ground up, is drawn as foot. */
  footShare: number;
  fur: P;
  footPart: P;
  stride: number;
  shade: (part: P, band: number) => number;
  /** Pixels too small for the model, put on after the cast where the model has them: eyes, tusks. */
  marks: { at: Vec3; index: number; side: Vec3 }[];
  stepMs: number;
};

/**
 * The standing frame is also the walk's passing frame: one front foot a little
 * ahead of the other and the hind pair staggered the other way. The two
 * strides move a front leg with the hind leg on the other side, and the body
 * sinks a pixel on each, which the planted legs take up.
 */
function posesFor(stride: number): Pose[] {
  return [
    { swing: [0.5, -0.3, -0.5, 0.3], dropPx: 0, lifts: false },
    { swing: [stride, -stride, -stride, stride], dropPx: 1, lifts: true },
    { swing: [-stride, stride, stride, -stride], dropPx: 1, lifts: true },
  ];
}

/** A leg swung back is pushing off: its foot is just off the ground, a front leg bends forward at the wrist and a hind leg back at the hock. */
const FOOT_LIFT = 0.8;
const FRONT_FOLD = 0.8;
const HIND_FOLD = 0.9;
const HIND_REST_FOLD = 0.3;

type Joint = { hip: Vec3; knee: Vec3; foot: Vec3 };

function jointOf<P extends string>(beast: Beast<P>, leg: number, pose: Pose): Joint {
  const [along, across] = beast.legs[leg]!;
  const swing = pose.swing[leg]!;
  const front = leg < 2;
  const lifted = pose.lifts && swing < 0;
  const hip: Vec3 = [along, across, beast.hipUp - pose.dropPx / beast.size];
  const foot: Vec3 = [along + swing, across, lifted ? FOOT_LIFT : 0];
  const fold = front ? (lifted ? FRONT_FOLD : 0) : -(lifted ? HIND_FOLD : HIND_REST_FOLD);
  const knee: Vec3 = [(hip[0] + foot[0]) / 2 + fold, across, (hip[2] + foot[2]) / 2];
  return { hip, knee, foot };
}

/** How far `p` lies from the segment `a`-`b`, and where along it, from 0 at `a` to 1 at `b`. */
function fromSegment(p: Vec3, a: Vec3, b: Vec3): { off: Vec3; t: number } {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const rel: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const lengthSq = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const t = Math.max(0, Math.min(1, (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / lengthSq));
  return { off: [rel[0] - d[0] * t, rel[1] - d[1] * t, rel[2] - d[2] * t], t };
}

function legHit<P extends string>(beast: Beast<P>, p: Vec3, joint: Joint): Hit<P> | null {
  const upper = fromSegment(p, joint.hip, joint.knee);
  if (Math.hypot(...upper.off) <= beast.thigh + (beast.knee - beast.thigh) * upper.t) {
    return { part: beast.fur, normal: upper.off };
  }
  const lower = fromSegment(p, joint.knee, joint.foot);
  const radius = beast.knee + (beast.foot - beast.knee) * lower.t;
  if (Math.hypot(...lower.off) > radius || p[2] < 0) return null;
  return { part: lower.t > 1 - beast.footShare ? beast.footPart : beast.fur, normal: lower.off };
}

function sampler<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose) {
  const [ax, ay] = AHEAD[facing];
  const centre = CELL_SIZE / 2;
  const joints = beast.legs.map((_, i) => jointOf(beast, i, pose));
  return (p: Vec3, scale: number): Hit<P> | null => {
    const x = (p[0] / scale - centre) / beast.size;
    const y = (p[1] / scale - centre) / beast.size;
    const along = x * ax + y * ay;
    const across = -x * ay + y * ax;
    const drop = pose.dropPx / beast.size;
    const up = p[2] / scale / beast.size + drop;
    const toWorld = (n: Vec3): Vec3 =>
      normalise([n[0] * ax - n[1] * ay, n[0] * ay + n[1] * ax, n[2]]);

    for (let i = beast.trunk.length - 1; i >= 0; i--) {
      const { part, at, radii, marking } = beast.trunk[i]!;
      const d: Vec3 = [along - at[0], across - at[1], up - at[2]];
      if ((d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2 > 1) continue;
      return {
        part: marking?.(along, across, up) ?? part,
        normal: toWorld([d[0] / radii[0] ** 2, d[1] / radii[1] ** 2, d[2] / radii[2] ** 2]),
      };
    }
    const legUp = up - drop;
    if (legUp < 0 || legUp > beast.hipUp) return null;
    for (const joint of joints) {
      const hit = legHit(beast, [along, across, legUp], joint);
      if (hit) return { part: hit.part, normal: toWorld(hit.normal) };
    }
    return null;
  };
}

/** Lit from the south-west and above, as every block here: top bright, south side mid, east side dark. */
const LIGHT = normalise([-0.5, 0.45, 0.75]);

function shader<P extends string>(beast: Beast<P>) {
  return (hit: Hit<P>): number => {
    const lit = hit.normal[0] * LIGHT[0] + hit.normal[1] * LIGHT[1] + hit.normal[2] * LIGHT[2];
    return beast.shade(hit.part, lit > 0.45 ? 0 : lit > -0.4 ? 1 : 2);
  };
}

/** A mark shows when the way it faces out of the body points south, east or up, the sides the projection draws. */
function markPixels<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose) {
  const [ax, ay] = AHEAD[facing];
  const centre = CELL_SIZE / 2;
  const ground = BASE_CELL * CELL_SIZE;
  const seen: { u: number; v: number; index: number }[] = [];
  for (const { at, index, side } of beast.marks) {
    const [along, across, raised] = at;
    const outX = side[0] * ax - side[1] * ay;
    const outY = side[0] * ay + side[1] * ax;
    if (outX + outY + side[2] <= 0) continue;
    const up = raised * beast.size - pose.dropPx;
    const x = centre + (along * ax - across * ay) * beast.size;
    const y = centre + (along * ay + across * ax) * beast.size;
    seen.push({ u: Math.floor(x + ground - up), v: Math.floor(y + ground - up), index });
  }
  return seen;
}

/** A dark edge all the way round, as the cat, the wolf and the bear have. */
function outlined(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const filled = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size && pixels[v * size + u]! >= 0;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (filled(u, v)) continue;
      if (filled(u - 1, v) || filled(u + 1, v) || filled(u, v - 1) || filled(u, v + 1)) {
        out[v * size + u] = OUTLINE;
      }
    }
  }
  return out;
}

function projection<P extends string>(beast: Beast<P>) {
  return { spritePx: FRAME_PX, groundPx: BASE_CELL * CELL_SIZE, topPx: beast.topPx };
}

function cast<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose): Int16Array {
  const model = { sample: sampler(beast, facing, pose), shade: shader(beast) };
  const pixels = castModel(model, projection(beast));
  for (const { u, v, index } of markPixels(beast, facing, pose)) {
    if (pixels[v * FRAME_PX + u]! >= 0) pixels[v * FRAME_PX + u] = index;
  }
  const onEdge = (n: number) =>
    n < FRAME_PX ||
    n >= FRAME_PX * (FRAME_PX - 1) ||
    n % FRAME_PX === 0 ||
    n % FRAME_PX === FRAME_PX - 1;
  if (pixels.some((index, n) => index >= 0 && onEdge(n))) {
    throw new Error(`the ${beast.id} facing ${facing} runs off its frame`);
  }
  return outlined(pixels, FRAME_PX);
}

type BoarPart = "coat" | "ridge" | "snout" | "disc" | "leg" | "hoof" | "ear";

/**
 * A wild boar: a wedge, deepest at the shoulders under a dark bristled ridge,
 * narrowing through a low-slung head to a long snout with a flat disc at the
 * end. The rump is lower and smaller than the shoulders, and the legs are
 * short and thin under all that weight.
 */
const BOAR: Beast<BoarPart> = {
  id: "boar",
  name: "Boar",
  size: 1,
  topPx: 11,
  trunk: [
    { part: "coat", at: [-3.4, 0, 4.4], radii: [2.6, 2.4, 1.9] },
    { part: "coat", at: [-1, 0, 5.0], radii: [3.0, 2.7, 2.3] },
    {
      part: "coat",
      at: [1.8, 0, 5.6],
      radii: [2.6, 2.7, 2.9],
      marking: (_along, across, up) => (up > 7.2 && Math.abs(across) < 1.2 ? "ridge" : null),
    },
    { part: "coat", at: [4.4, 0, 4.3], radii: [1.9, 1.9, 2.0] },
    { part: "ear", at: [3.7, -1.3, 6.4], radii: [0.6, 0.6, 0.8] },
    { part: "ear", at: [3.7, 1.3, 6.4], radii: [0.6, 0.6, 0.8] },
    { part: "snout", at: [6.3, 0, 3.5], radii: [1.5, 1.05, 1.05] },
    { part: "disc", at: [7.6, 0, 3.5], radii: [0.45, 0.95, 0.9] },
  ],
  legs: [
    [2.2, 1.5],
    [2.2, -1.5],
    [-3.4, 1.5],
    [-3.4, -1.5],
  ],
  hipUp: 4.2,
  thigh: 1.15,
  knee: 0.8,
  foot: 0.8,
  footShare: 0.25,
  fur: "leg",
  footPart: "hoof",
  stride: 1.3,
  shade: (part, band) => {
    if (part === "disc") return 14;
    if (part === "hoof") return 0;
    if (part === "ridge") return [0, 0, 0][band]!;
    if (part === "snout") return [22, 8, 4][band]!;
    if (part === "ear" || part === "leg") return [2, 0, 0][band]!;
    return [22, 8, 2][band]!;
  },
  marks: [
    { at: [4.8, 1.2, 5.1], index: 0, side: [0.5, 1, 0.3] },
    { at: [4.8, -1.2, 5.1], index: 0, side: [0.5, -1, 0.3] },
    { at: [6.6, 1.2, 3.9], index: 28, side: [0.2, 1, 0.3] },
    { at: [6.6, -1.2, 3.9], index: 28, side: [0.2, -1, 0.3] },
  ],
  stepMs: 110,
};

type RaccoonPart =
  | "coat"
  | "tail"
  | "belly"
  | "face"
  | "mask"
  | "muzzle"
  | "nose"
  | "ear"
  | "leg"
  | "paw"
  | "ring";

/** The ringed tail: a dark band every this many pixels along it. */
const RING_PX = 1.2;

function ringed(along: number): RaccoonPart | null {
  return Math.floor(-along / RING_PX) % 2 === 0 ? "ring" : null;
}

/**
 * A raccoon: a hunched grey body higher at the rump than the shoulders, a
 * broad head with a pale muzzle and the black mask across the eyes, and a
 * bushy tail as long as the body in dark rings. Lower than the boar, about a
 * cat's size.
 */
const RACCOON: Beast<RaccoonPart> = {
  id: "raccoon",
  name: "Raccoon",
  size: 1.2,
  topPx: 9,
  trunk: [
    { part: "tail", at: [-7.0, 0, 4.4], radii: [1.0, 1.0, 1.0], marking: ringed },
    { part: "tail", at: [-5.6, 0, 4.0], radii: [1.3, 1.2, 1.2], marking: ringed },
    { part: "tail", at: [-4.0, 0, 3.5], radii: [1.4, 1.3, 1.3], marking: ringed },
    { part: "coat", at: [-1.5, 0, 3.1], radii: [2.1, 1.9, 1.8] },
    {
      part: "coat",
      at: [0.9, 0, 2.8],
      radii: [1.9, 1.8, 1.7],
      marking: (_along, _across, up) => (up < 1.6 ? "belly" : null),
    },
    {
      part: "face",
      at: [2.9, 0, 3.0],
      radii: [1.4, 1.6, 1.4],
      marking: (along, _across, up) => (along > 3.0 && up > 2.7 && up < 3.6 ? "mask" : null),
    },
    { part: "ear", at: [2.5, -1.1, 4.3], radii: [0.5, 0.5, 0.6] },
    { part: "ear", at: [2.5, 1.1, 4.3], radii: [0.5, 0.5, 0.6] },
    { part: "muzzle", at: [4.2, 0, 2.6], radii: [0.9, 0.75, 0.7] },
    { part: "nose", at: [5.0, 0, 2.7], radii: [0.4, 0.4, 0.4] },
  ],
  legs: [
    [1.2, 1.1],
    [1.2, -1.1],
    [-2.3, 1.1],
    [-2.3, -1.1],
  ],
  hipUp: 2.4,
  thigh: 0.85,
  knee: 0.6,
  foot: 0.6,
  footShare: 0.35,
  fur: "leg",
  footPart: "paw",
  stride: 0.9,
  shade: (part, band) => {
    if (part === "nose" || part === "mask" || part === "paw") return 0;
    if (part === "ring") return [1, 0, 0][band]!;
    if (part === "tail") return [27, 25, 22][band]!;
    if (part === "muzzle" || part === "face") return [28, 27, 25][band]!;
    if (part === "ear") return [22, 4, 1][band]!;
    if (part === "belly") return [22, 8, 4][band]!;
    if (part === "leg") return [4, 1, 0][band]!;
    return [22, 8, 4][band]!;
  },
  marks: [],
  stepMs: 90,
};

function frame(pose: number, row: number, durationMs: number) {
  return {
    sprite: {
      rect: { x: pose * FRAME_CELLS, y: row * FRAME_CELLS, w: FRAME_CELLS, h: FRAME_CELLS },
      base: { x: BASE_CELL, y: BASE_CELL },
    },
    durationMs,
  };
}

function facingFrames(firstRow: number, poses: readonly number[], durationMs: number) {
  return Object.fromEntries(
    FACINGS.map((facing, row) => [
      facing,
      { frames: poses.map((pose) => frame(pose, firstRow + row, durationMs)) },
    ]),
  );
}

const PREY = { type: "slot", data: { name: "prey" } };

/**
 * The boar roots about its patch and leaves people alone unless they come
 * within a few cells, when it goes for them. A target that backs off past
 * three cells gets charged, as the bear charges, and the charge leaves it
 * winded so it cannot charge again at once.
 */
const BOAR_BRAIN = {
  initial: "rooting",
  states: {
    rooting: {
      do: [
        { action: "wait", ms: 1500 },
        { action: "walk_n_steps", steps: 2 },
      ],
    },
    goring: {
      onEnter: [{ effect: "noise", text: "GRUNT", style: "shake" }],
      do: [{ action: "attack", of: PREY }, { action: "step_toward", of: PREY }, { action: "hold" }],
    },
    charging: {
      band: "danger",
      do: [{ action: "cast", spell: 1 }, { action: "step_toward", of: PREY }, { action: "hold" }],
    },
  },
  triggers: [
    {
      band: "danger",
      if: {
        combinator: "and",
        rules: [
          { cond: "out_of_range", of: PREY, cells: 3 },
          { cond: "in_los", of: PREY, cells: 8 },
          { combinator: "and", not: true, rules: [{ cond: "status", id: "winded" }] },
        ],
      },
      to: "charging",
    },
  ],
  transitions: [{ from: "charging", if: { cond: "after", ms: 0 }, to: "goring" }],
  traits: [
    { trait: "evades-the-unreachable", with: {} },
    { trait: "fights-back", with: { fight: "goring", target: "prey", calm: 10 } },
    {
      trait: "hunts-on-sight",
      with: { prey: ["player"], within: 3, fight: "goring", target: "prey", calm: 10 },
    },
    {
      trait: "eats-when-hungry",
      with: { food: ["apple", "berry", "rotten-apple", "stale-berry"], cry: "snf" },
    },
    { trait: "forages", with: { bush: ["bush"], berry: "berry" } },
    { trait: "returns-home", with: { leash: 12 } },
    { trait: "unsticks", with: {} },
  ],
};

/** Between the rat (Sharp 4, Toughness 3) and the wolf (Sharp 30, Toughness 22), and slower and heavier than either. */
const BOAR_BATTLER = {
  baseHp: 24,
  masteries: { blunt: 18, arcane: 4, toughness: 22, agility: 10 },
  naturalWeapon: {
    type: "weapon",
    name: "Tusks",
    damage: 3,
    def: 0,
    accuracy: 82,
    variance: 40,
    spd: 42,
    reach: { cells: 1.5, height: 2 },
    mastery: "blunt",
  },
  sight: { up: 0, down: 0 },
  immuneTo: ["food-poisoning"],
  kit: [
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "boar-tusk", chance: 70 },
        { tileId: "raw-meat", chance: 100 },
        { tileId: "raw-meat", chance: 40 },
        { tileId: "skin", chance: 50 },
      ],
    },
  ],
  spells: [
    {
      type: "stone",
      name: "Charge",
      effect: {
        kind: "bolt",
        on: "caster",
        statuses: [
          { id: "charging", chance: 100 },
          { id: "winded", chance: 100 },
        ],
      },
      cooldownMs: 10000,
      sound: "snort",
    },
  ],
};

/**
 * The raccoon is a thief, not a fighter: it goes for any food it sees lying
 * about, picks bushes, and runs from anybody rated past it. A player weaker
 * than that it turns on when hit, and it gives up a fight once it is hurt.
 */
const RACCOON_BRAIN = {
  initial: "snuffling",
  states: {
    snuffling: { do: [{ action: "walk_n_steps", steps: 3 }] },
    sniffing: { do: [{ action: "walk_n_steps", steps: 1 }] },
    scratching: {
      onEnter: [{ effect: "noise", text: "hsss" }],
      do: [
        { action: "attack", of: PREY },
        { action: "step_toward", of: PREY, allowDrops: true },
        { action: "hold" },
      ],
    },
  },
  transitions: [
    { from: "snuffling", if: { cond: "stuck" }, to: "sniffing" },
    { from: "sniffing", if: { cond: "after", ms: 900 }, to: "snuffling" },
  ],
  traits: [
    {
      trait: "flees-the-stronger",
      with: { threats: ["player"], sight: 6, below: 16, cry: "chrr!" },
    },
    { trait: "flees-when-hurt", with: { threat: "prey", below: 30, near: 8, cry: "eek" } },
    { trait: "fights-back", with: { fight: "scratching", target: "prey", calm: 8 } },
    { trait: "scavenges", with: { cry: "chitter" } },
    { trait: "forages", with: { bush: ["bush"], berry: "berry" } },
    { trait: "returns-home", with: { leash: 12 } },
  ],
};

/** A step above the rat in every mastery, and quick: hard to hit more than hard-hitting. */
const RACCOON_BATTLER = {
  baseHp: 10,
  masteries: { sharp: 9, arcane: 3, toughness: 8, agility: 26 },
  naturalWeapon: {
    type: "weapon",
    name: "Claws",
    damage: 2,
    def: 0,
    accuracy: 82,
    variance: 60,
    spd: 56,
    reach: { cells: 1.5, height: 2 },
    mastery: "sharp",
  },
  sight: { up: 1, down: 1 },
  immuneTo: ["food-poisoning"],
  kit: [
    { slot: "offhand", tileId: "bread", chance: 10 },
    { slot: "weapon", tileId: "apple", chance: 10 },
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "raccoon-tail", chance: 70 },
        { tileId: "skin", chance: 20 },
      ],
    },
  ],
};

const POSES_PER_BEAST = 3;

function tileOf<P extends string>(
  beast: Beast<P>,
  firstRow: number,
  fields: Partial<TileDef>,
): TileDef {
  return {
    id: beast.id,
    name: beast.name,
    type: "directional",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    lightPassing: true,
    affectedByGravity: true,
    walkable: false,
    sprites: facingFrames(firstRow, [0], beast.stepMs * 2),
    states: { moving: { sprites: facingFrames(firstRow, [0, 1, 0, 2], beast.stepMs) } },
    ...fields,
  } as TileDef;
}

const tiles = [
  tileOf(BOAR, 0, {
    height: 2,
    walkDurationMs: 170,
    interactions: {
      brain: BOAR_BRAIN,
      battler: BOAR_BATTLER,
      respawn: { fromMs: 150000, toMs: 300000 },
    },
  } as Partial<TileDef>),
  tileOf(RACCOON, FACINGS.length, {
    height: 1,
    walkDurationMs: 150,
    swims: true,
    interactions: {
      brain: RACCOON_BRAIN,
      battler: RACCOON_BATTLER,
      respawn: { fromMs: 90000, toMs: 180000 },
    },
  } as Partial<TileDef>),
];

const BEASTS = [BOAR, RACCOON] as Beast<string>[];

const sheet = new PNG({
  width: POSES_PER_BEAST * FRAME_PX,
  height: BEASTS.length * FACINGS.length * FRAME_PX,
});
sheet.data.fill(0);
BEASTS.forEach((beast, b) => {
  const poses = posesFor(beast.stride);
  FACINGS.forEach((facing, f) => {
    const row = b * FACINGS.length + f;
    poses.forEach((pose, column) => {
      cast(beast, facing, pose).forEach((index, n) => {
        if (index < 0) return;
        const x = column * FRAME_PX + (n % FRAME_PX);
        paint(sheet, x, row * FRAME_PX + Math.floor(n / FRAME_PX), index);
      });
    });
  });
});

const previewDir = process.env.PREVIEW;
if (previewDir) {
  const scale = 8;
  const preview = new PNG({ width: sheet.width * scale, height: sheet.height * scale });
  const backdrop = paletteRgba(15);
  for (let y = 0; y < preview.height; y++) {
    for (let x = 0; x < preview.width; x++) {
      const from = (sheet.width * Math.floor(y / scale) + Math.floor(x / scale)) << 2;
      const to = (preview.width * y + x) << 2;
      const opaque = sheet.data[from + 3]! > 0;
      for (let c = 0; c < 4; c++) {
        preview.data[to + c] = opaque ? sheet.data[from + c]! : backdrop[c]!;
      }
    }
  }
  await Bun.write(path.join(previewDir, `${TILESET_ID}.png`), PNG.sync.write(preview));
  const large = 6;
  for (const beast of process.env.LARGE ? BEASTS : []) {
    for (const facing of FACINGS) {
      const model = {
        sample: sampler(beast, facing, posesFor(beast.stride)[0]!),
        shade: shader(beast),
      };
      const pixels = castModel(model, projection(beast), large);
      await writeCast(path.join(previewDir, `${beast.id}-${facing}.png`), pixels, FRAME_PX * large);
    }
  }
} else {
  await writeTileset(TILESET_ID, "Forest beasts", sheet, tiles);
}
