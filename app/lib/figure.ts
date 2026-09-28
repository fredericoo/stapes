import * as v from "valibot";
import {
  STAPES_PALETTE,
  hexToRgb01,
  nearestPaletteIndex,
  paletteOklab,
  srgbToOklab,
} from "./palette";
import { CELL_SIZE } from "./types";
import type { Direction } from "./types";

export const HAIR_STYLES = ["bald", "short", "bob", "long", "ponytail"] as const;

export const CLOAK_STYLES = ["none", "cape", "cloak", "hooded"] as const;

export const LOWER_STYLES = ["trousers", "robe"] as const;

const colour = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i));

export const figureLookSchema = v.object({
  skin: colour,
  hair: v.object({ style: v.picklist(HAIR_STYLES), colour }),
  beard: v.boolean(),
  shirt: colour,
  lower: v.object({ style: v.picklist(LOWER_STYLES), colour }),
  shoes: colour,
  cloak: v.object({ style: v.picklist(CLOAK_STYLES), colour }),
});

export type FigureLook = v.InferOutput<typeof figureLookSchema>;

export const DEFAULT_LOOK: FigureLook = {
  skin: "#e6904e",
  hair: { style: "short", colour: "#6e2727" },
  beard: false,
  shirt: "#c7dcd0",
  lower: { style: "trousers", colour: "#7f708a" },
  shoes: "#45293f",
  cloak: { style: "none", colour: "#165a4c" },
};

export type WalkPose = "stepA" | "stand" | "stepB";

/** Rows and columns of one character block, in the order `people.png` draws them. */
export const SHEET_FACINGS: readonly Direction[] = ["s", "e", "w", "n"];
export const SHEET_POSES: readonly WalkPose[] = ["stepA", "stand", "stepB"];

export const FRAME_PX = 2 * CELL_SIZE;
export const SHEET_WIDTH_PX = SHEET_POSES.length * FRAME_PX;
export const SHEET_HEIGHT_PX = SHEET_FACINGS.length * FRAME_PX;

const OUTLINE_COLOUR = "#2e222f";

/**
 * The foot sits at the centre of the sprite's bottom-right cell, which is the
 * cell a `base` of (1, 1) stands on the map.
 */
const FOOT_PX = FRAME_PX - CELL_SIZE / 2;

const SUPERSAMPLE = 4;
const COVERAGE = 0.5;
const MARCH_TOP = 9;
const MARCH_BOTTOM = -0.5;
const HIT_EPSILON = 0.02;
const MAX_STEPS = 64;
const SHADOW_RADIUS = 1.9;
const CREASE_DEPTH = 1.6;

/** Light from above and to the south-west, so the tops and the south faces read bright. */
const LIGHT = normalize([-0.35, 0.45, 1]);
const HIGHLIGHT_ABOVE = 0.8;
const SHADOW_BELOW = 0.12;

type Vec3 = [number, number, number];

const enum Mat {
  Skin,
  Hair,
  Shirt,
  Lower,
  Shoes,
  Cloak,
}

const MATERIAL_COUNT = 6;

type Shape = {
  mat: Mat;
  dist: (p: Vec3) => number;
};

function normalize([x, y, z]: Vec3): Vec3 {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

function sphere(c: Vec3, r: number) {
  return (p: Vec3) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) - r;
}

/** Ellipsoid bound from Iñigo Quilez: exact on the axes, a close underestimate elsewhere. */
function ellipsoid(c: Vec3, r: Vec3) {
  return (p: Vec3) => {
    const x = (p[0] - c[0]) / r[0];
    const y = (p[1] - c[1]) / r[1];
    const z = (p[2] - c[2]) / r[2];
    const k0 = Math.hypot(x, y, z);
    const k1 = Math.hypot(x / r[0], y / r[1], z / r[2]);
    return k1 === 0 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
  };
}

function capsule(a: Vec3, b: Vec3, ra: number, rb = ra) {
  const ba: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
  return (p: Vec3) => {
    const pa0 = p[0] - a[0];
    const pa1 = p[1] - a[1];
    const pa2 = p[2] - a[2];
    const h = Math.max(0, Math.min(1, (pa0 * ba[0] + pa1 * ba[1] + pa2 * ba[2]) / len2));
    return Math.hypot(pa0 - ba[0] * h, pa1 - ba[1] * h, pa2 - ba[2] * h) - (ra + (rb - ra) * h);
  };
}

function roundBox(c: Vec3, half: Vec3, r: number) {
  return (p: Vec3) => {
    const qx = Math.abs(p[0] - c[0]) - half[0] + r;
    const qy = Math.abs(p[1] - c[1]) - half[1] + r;
    const qz = Math.abs(p[2] - c[2]) - half[2] + r;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    return outside + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}

/** A cone frustum around the vertical axis, from radius `r0` at `z0` to `r1` at `z1`, squashed front-to-back by `depth`. */
function skirt(c: Vec3, z0: number, r0: number, z1: number, r1: number, depth: number) {
  return (p: Vec3) => {
    const t = Math.max(0, Math.min(1, (p[2] - z0) / (z1 - z0)));
    const r = r0 + (r1 - r0) * t;
    const radial = Math.hypot(p[0] - c[0], (p[1] - c[1]) / depth) - r;
    const vertical = Math.max(z0 - p[2], p[2] - z1);
    return Math.max(radial * depth, vertical);
  };
}

function intersect(a: (p: Vec3) => number, b: (p: Vec3) => number) {
  return (p: Vec3) => Math.max(a(p), b(p));
}

function subtract(a: (p: Vec3) => number, b: (p: Vec3) => number) {
  return (p: Vec3) => Math.max(a(p), -b(p));
}

function above(z: number) {
  return (p: Vec3) => z - p[2];
}

function below(z: number) {
  return (p: Vec3) => p[2] - z;
}

function frontOf(y: number) {
  return (p: Vec3) => y - p[1];
}

type Pose = { stride: number; bob: number };

const POSES: Record<WalkPose, Pose> = {
  stepA: { stride: 1, bob: -0.2 },
  stand: { stride: 0, bob: 0 },
  stepB: { stride: -1, bob: -0.2 },
};

/**
 * Heights of the joints, in screen pixels above the ground. The game draws a
 * body three height units tall, which is six pixels, and the hand-drawn
 * player spends nearly half of it on the head.
 */
const BODY = {
  footZ: 0.35,
  hipZ: 1.9,
  chestZ: 2.85,
  shoulderZ: 3.35,
  headZ: 4.55,
  headR: 1.4,
  legX: 0.6,
  shoulderX: 2,
  stride: 0.9,
};

type Add = (mat: Mat, dist: (p: Vec3) => number) => void;

/** The figure in its own frame: feet on z = 0, facing +y, one unit is one screen pixel. */
function buildFigure(look: FigureLook, pose: WalkPose): Shape[] {
  const { stride, bob } = POSES[pose];
  const shapes: Shape[] = [];
  const add: Add = (mat, dist) => shapes.push({ mat, dist });

  const hipZ = BODY.hipZ + bob;
  const chestZ = BODY.chestZ + bob;
  const shoulderZ = BODY.shoulderZ + bob;
  const headC: Vec3 = [0, 0.15, BODY.headZ + bob];
  const step = BODY.stride * stride;

  for (const side of [-1, 1] as const) {
    const forward = step * side;
    const hip: Vec3 = [BODY.legX * side, 0, hipZ];
    const ankle: Vec3 = [BODY.legX * side, forward, BODY.footZ + 0.3];
    add(Mat.Lower, capsule(hip, ankle, 0.62, 0.5));
    add(Mat.Shoes, ellipsoid([ankle[0], forward + 0.2, BODY.footZ], [0.55, 0.75, 0.42]));
  }

  add(
    Mat.Shirt,
    roundBox([0, 0, (hipZ + shoulderZ) / 2], [1.45, 0.8, (shoulderZ - hipZ) / 2 + 0.3], 0.6),
  );
  if (look.lower.style === "robe")
    add(Mat.Lower, skirt([0, 0, 0], 0.2, 1.6, hipZ + 0.2, 1.25, 0.8));

  for (const side of [-1, 1] as const) {
    const swing = -step * side * 1.4;
    const shoulder: Vec3 = [BODY.shoulderX * side, 0, shoulderZ];
    const elbow: Vec3 = [(BODY.shoulderX + 0.35) * side, swing * 0.5, shoulderZ - 0.8];
    const hand: Vec3 = [(BODY.shoulderX + 0.7) * side, swing, hipZ];
    add(Mat.Shirt, capsule(shoulder, elbow, 0.55, 0.5));
    add(Mat.Skin, capsule(elbow, hand, 0.45, 0.45));
  }

  add(Mat.Skin, sphere(headC, BODY.headR));

  addHair(look, headC, BODY.headR, add);
  addCloak(look, headC, BODY.headR, chestZ, shoulderZ, step, add);

  return shapes;
}

function addHair(look: FigureLook, headC: Vec3, headR: number, add: Add) {
  const [hx, hy, hz] = headC;
  const shell = sphere([hx, hy - 0.15, hz + 0.05], headR + 0.18);
  /** The shell minus the face: everything above the brow, plus the whole back of the head. */
  const cap = subtract(shell, intersect(frontOf(hy - 0.1), below(hz + 0.85)));

  switch (look.hair.style) {
    case "bald":
      break;
    case "short":
      add(Mat.Hair, intersect(cap, above(hz - 0.3)));
      break;
    case "bob":
      add(Mat.Hair, intersect(cap, above(hz - 1.1)));
      break;
    case "long":
      add(Mat.Hair, cap);
      add(Mat.Hair, roundBox([hx, hy - 0.75, hz - 1.5], [1.3, 0.55, 1.3], 0.5));
      break;
    case "ponytail":
      add(Mat.Hair, intersect(cap, above(hz - 0.3)));
      add(Mat.Hair, capsule([hx, hy - 1.4, hz + 0.1], [hx, hy - 1.7, hz - 1.9], 0.5, 0.35));
      break;
  }

  if (look.beard) add(Mat.Hair, ellipsoid([hx, hy + 0.95, hz - 0.8], [0.95, 0.5, 0.65]));
}

function addCloak(
  look: FigureLook,
  headC: Vec3,
  headR: number,
  chestZ: number,
  shoulderZ: number,
  step: number,
  add: Add,
) {
  const style = look.cloak.style;
  if (style === "none") return;
  const flutter = Math.abs(step) * 0.4;

  if (style === "cape") {
    add(Mat.Cloak, capsule([0, -0.95, shoulderZ], [0, -1.2 - flutter, 0.9], 1.35, 1.7));
    return;
  }

  /** A cloak is open at the front below the collar, so the shirt and legs show through. */
  const body = subtract(
    skirt([0, -0.1, 0], 0.4, 2.05, shoulderZ + 0.35, 1.65, 0.75),
    intersect(frontOf(0.3), below(chestZ)),
  );
  add(Mat.Cloak, body);
  add(Mat.Cloak, capsule([0, -1 - flutter, 0.8], [0, -0.9, shoulderZ], 1.5, 1.4));

  if (style === "hooded") {
    const [hx, hy, hz] = headC;
    const hood = sphere([hx, hy - 0.2, hz + 0.1], headR + 0.35);
    const face = intersect(sphere([hx, hy + 1, hz - 0.2], headR), frontOf(hy + 0.2));
    add(Mat.Cloak, subtract(hood, face));
  }
}

function sceneDistance(shapes: Shape[], p: Vec3): { d: number; mat: Mat } {
  let d = Infinity;
  let mat = Mat.Skin;
  for (const s of shapes) {
    const sd = s.dist(p);
    if (sd < d) {
      d = sd;
      mat = s.mat;
    }
  }
  return { d, mat };
}

function sceneNormal(shapes: Shape[], p: Vec3): Vec3 {
  const e = 0.05;
  const at = (x: number, y: number, z: number) => sceneDistance(shapes, [x, y, z]).d;
  return normalize([
    at(p[0] + e, p[1], p[2]) - at(p[0] - e, p[1], p[2]),
    at(p[0], p[1] + e, p[2]) - at(p[0], p[1] - e, p[2]),
    at(p[0], p[1], p[2] + e) - at(p[0], p[1], p[2] - e),
  ]);
}

const TURN: Record<Direction, [number, number]> = {
  s: [1, 0],
  e: [0, 1],
  n: [-1, 0],
  w: [0, -1],
};

/** World to figure: undo the facing's turn, so the figure is always modelled facing south. */
function toFigure(p: Vec3, facing: Direction): Vec3 {
  const [c, s] = TURN[facing];
  return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
}

function fromFigure(v: Vec3, facing: Direction): Vec3 {
  const [c, s] = TURN[facing];
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

type Hit = { t: number; mat: Mat; light: number };

/**
 * A screen pixel is the ray `(u + t, v + t, t)`: the projection moves one
 * pixel up and one left per pixel of height, so every point on it lands on
 * the same pixel, and the camera is at large `t`. Marching from the top down
 * finds the surface nearest the camera first.
 */
function castRay(shapes: Shape[], u: number, v: number, facing: Direction): Hit | null {
  const inv = 1 / Math.sqrt(3);
  let t = MARCH_TOP;
  for (let i = 0; i < MAX_STEPS && t > MARCH_BOTTOM; i++) {
    const world: Vec3 = [u + t, v + t, t];
    const { d, mat } = sceneDistance(shapes, toFigure(world, facing));
    if (d < HIT_EPSILON) {
      const n = fromFigure(sceneNormal(shapes, toFigure(world, facing)), facing);
      const light = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
      return { t, mat, light };
    }
    t -= Math.max(d * inv, HIT_EPSILON);
  }
  return null;
}

type Ramp = [shadow: string, base: string, highlight: string];

const PALETTE_LAB = paletteOklab(STAPES_PALETTE);

function labOf(hex: string) {
  return srgbToOklab(...hexToRgb01(hex));
}

/**
 * The step to a darker or lighter palette entry: the nearest entry to the
 * base moved in lightness, excluding the base itself, with a chroma weight so
 * a shadow stays in the base's hue family rather than jumping to grey.
 */
function neighbour(hex: string, dL: number): string {
  const [L, a, b] = labOf(hex);
  const self = STAPES_PALETTE.indexOf(hex);
  let best = hex;
  let bestD = Infinity;
  for (let i = 0; i < STAPES_PALETTE.length; i++) {
    if (i === self || STAPES_PALETTE[i] === OUTLINE_COLOUR) continue;
    const pl = PALETTE_LAB[i * 3]!;
    const pa = PALETTE_LAB[i * 3 + 1]!;
    const pb = PALETTE_LAB[i * 3 + 2]!;
    if (Math.sign(pl - L) !== Math.sign(dL)) continue;
    const d = (pl - (L + dL)) ** 2 + 2.5 * ((pa - a) ** 2 + (pb - b) ** 2);
    if (d < bestD) {
      bestD = d;
      best = STAPES_PALETTE[i]!;
    }
  }
  return best;
}

function snapToPalette(hex: string): string {
  return STAPES_PALETTE[nearestPaletteIndex(labOf(hex), PALETTE_LAB)]!;
}

export function rampFor(hex: string): Ramp {
  const base = snapToPalette(hex);
  return [neighbour(base, -0.14), base, neighbour(base, 0.12)];
}

function rampsFor(look: FigureLook): Ramp[] {
  const ramps: Ramp[] = new Array(MATERIAL_COUNT);
  ramps[Mat.Skin] = rampFor(look.skin);
  ramps[Mat.Hair] = rampFor(look.hair.colour);
  ramps[Mat.Shirt] = rampFor(look.shirt);
  ramps[Mat.Lower] = rampFor(look.lower.colour);
  ramps[Mat.Shoes] = rampFor(look.shoes);
  ramps[Mat.Cloak] = rampFor(look.cloak.colour);
  return ramps;
}

function writeHex(out: Uint8ClampedArray, i: number, hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  out[i] = (n >> 16) & 0xff;
  out[i + 1] = (n >> 8) & 0xff;
  out[i + 2] = n & 0xff;
  out[i + 3] = 255;
}

export function renderFigureFrame(
  look: FigureLook,
  facing: Direction,
  pose: WalkPose,
): Uint8ClampedArray<ArrayBuffer> {
  const shapes = buildFigure(look, pose);
  const ramps = rampsFor(look);
  const out = new Uint8ClampedArray(FRAME_PX * FRAME_PX * 4);
  const filled = new Uint8Array(FRAME_PX * FRAME_PX);
  const depth = new Float32Array(FRAME_PX * FRAME_PX);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < FRAME_PX; py++) {
    for (let px = 0; px < FRAME_PX; px++) {
      const votes = new Array<number>(MATERIAL_COUNT).fill(0);
      const light = new Array<number>(MATERIAL_COUNT).fill(0);
      let hits = 0;
      let nearest = -Infinity;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = px + (sx + 0.5) / SUPERSAMPLE - FOOT_PX;
          const v = py + (sy + 0.5) / SUPERSAMPLE - FOOT_PX;
          const hit = castRay(shapes, u, v, facing);
          if (!hit) continue;
          hits++;
          votes[hit.mat]!++;
          light[hit.mat]! += hit.light;
          nearest = Math.max(nearest, hit.t);
        }
      }
      if (hits / samples < COVERAGE) continue;
      let mat = 0;
      for (let m = 1; m < MATERIAL_COUNT; m++) if (votes[m]! > votes[mat]!) mat = m;
      const lit = light[mat]! / votes[mat]!;
      const [shadow, base, highlight] = ramps[mat]!;
      const tone = lit > HIGHLIGHT_ABOVE ? highlight : lit < SHADOW_BELOW ? shadow : base;
      writeHex(out, (py * FRAME_PX + px) * 4, tone);
      filled[py * FRAME_PX + px] = 1;
      depth[py * FRAME_PX + px] = nearest;
    }
  }

  crease(out, filled, depth);
  outline(out, filled);
  return out;
}

/**
 * A pixel with a neighbour much nearer the camera is where one part passes in
 * front of another, such as an arm over the body, and is drawn in the
 * outline colour so the two do not merge into one shape.
 */
function crease(out: Uint8ClampedArray, filled: Uint8Array, depth: Float32Array) {
  const marks: number[] = [];
  for (let py = 0; py < FRAME_PX; py++) {
    for (let px = 0; px < FRAME_PX; px++) {
      const i = py * FRAME_PX + px;
      if (!filled[i]) continue;
      const nearer = (j: number) => filled[j] === 1 && depth[j]! - depth[i]! > CREASE_DEPTH;
      if (
        (px > 0 && nearer(i - 1)) ||
        (px < FRAME_PX - 1 && nearer(i + 1)) ||
        (py > 0 && nearer(i - FRAME_PX)) ||
        (py < FRAME_PX - 1 && nearer(i + FRAME_PX))
      )
        marks.push(i);
    }
  }
  for (const i of marks) writeHex(out, i * 4, OUTLINE_COLOUR);
}

/** A one-pixel outline round the silhouette, and a shadow on the ground under the feet in the same colour. */
function outline(out: Uint8ClampedArray, filled: Uint8Array) {
  for (let py = 0; py < FRAME_PX; py++) {
    for (let px = 0; px < FRAME_PX; px++) {
      const i = py * FRAME_PX + px;
      if (filled[i]) continue;
      const edge =
        (px > 0 && filled[i - 1] === 1) ||
        (px < FRAME_PX - 1 && filled[i + 1] === 1) ||
        (py > 0 && filled[i - FRAME_PX] === 1) ||
        (py < FRAME_PX - 1 && filled[i + FRAME_PX] === 1);
      const ground = Math.hypot(px + 0.5 - FOOT_PX, py + 0.5 - FOOT_PX) < SHADOW_RADIUS;
      if (edge || ground) writeHex(out, i * 4, OUTLINE_COLOUR);
    }
  }
}

export function renderFigureSheet(look: FigureLook): Uint8ClampedArray<ArrayBuffer> {
  const sheet = new Uint8ClampedArray(SHEET_WIDTH_PX * SHEET_HEIGHT_PX * 4);
  SHEET_FACINGS.forEach((facing, row) => {
    SHEET_POSES.forEach((pose, col) => {
      const frame = renderFigureFrame(look, facing, pose);
      for (let y = 0; y < FRAME_PX; y++) {
        const src = y * FRAME_PX * 4;
        const dst = ((row * FRAME_PX + y) * SHEET_WIDTH_PX + col * FRAME_PX) * 4;
        sheet.set(frame.subarray(src, src + FRAME_PX * 4), dst);
      }
    });
  });
  return sheet;
}
