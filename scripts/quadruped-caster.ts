import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE } from "../app/lib/types";
import { normalise, type Vec3 } from "./limb-caster";
import { castModel, writeCast } from "./model-caster";
import { paint, paletteRgba } from "./tileset-output";

/** Four cells square with the beast standing on the third, so its snout, tail and lean all fit. */
export const FRAME_CELLS = 4;
export const BASE_CELL = 2;
export const FRAME_PX = FRAME_CELLS * CELL_SIZE;
const OUTLINE = 0;

export type Facing = "n" | "e" | "s" | "w";
export const FACINGS: Facing[] = ["s", "n", "e", "w"];

/** The way a facing looks on the ground: x is east and y is south. */
const AHEAD: Record<Facing, [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};

/** Along the beast, across it to its right, and up, from the middle of its cell on the ground, in pixels before `size`. */
export type Ellipsoid<P extends string> = {
  part: P;
  at: Vec3;
  radii: Vec3;
  /** Repaints a point of this ellipsoid as another part, for markings that follow the body. */
  marking?: (along: number, across: number, up: number) => P | null;
};

type Pose = { swing: [number, number, number, number]; dropPx: number; lifts: boolean };

type Hit<P extends string> = { part: P; normal: Vec3 };

export type Beast<P extends string> = {
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
export function posesFor(stride: number): Pose[] {
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

export function sampler<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose) {
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

export function shader<P extends string>(beast: Beast<P>) {
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

export function projection<P extends string>(beast: Beast<P>) {
  return { spritePx: FRAME_PX, groundPx: BASE_CELL * CELL_SIZE, topPx: beast.topPx };
}

export function cast<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose): Int16Array {
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

function frame(pose: number, row: number, durationMs: number) {
  return {
    sprite: {
      rect: { x: pose * FRAME_CELLS, y: row * FRAME_CELLS, w: FRAME_CELLS, h: FRAME_CELLS },
      base: { x: BASE_CELL, y: BASE_CELL },
    },
    durationMs,
  };
}

export function facingFrames(firstRow: number, poses: readonly number[], durationMs: number) {
  return Object.fromEntries(
    FACINGS.map((facing, row) => [
      facing,
      { frames: poses.map((pose) => frame(pose, firstRow + row, durationMs)) },
    ]),
  );
}

export const POSES_PER_BEAST = 3;

/** Paints every facing and walking pose of `beast` into `sheet`, a row of frames per facing from `firstRow`. */
export function paintBeast<P extends string>(sheet: PNG, beast: Beast<P>, firstRow: number) {
  const poses = posesFor(beast.stride);
  FACINGS.forEach((facing, f) => {
    const row = firstRow + f;
    poses.forEach((pose, column) => {
      cast(beast, facing, pose).forEach((index, n) => {
        if (index < 0) return;
        const x = column * FRAME_PX + (n % FRAME_PX);
        paint(sheet, x, row * FRAME_PX + Math.floor(n / FRAME_PX), index);
      });
    });
  });
}

/**
 * Writes `sheet` eight times larger on `grass-2`'s colour as `<name>.png`, and
 * with `LARGE` set each beast's standing pose cast six times larger, which
 * takes minutes.
 */
export async function writePreview(dir: string, name: string, sheet: PNG, beasts: Beast<string>[]) {
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
  await Bun.write(path.join(dir, `${name}.png`), PNG.sync.write(preview));
  const large = 6;
  for (const beast of process.env.LARGE ? beasts : []) {
    for (const facing of FACINGS) {
      const model = {
        sample: sampler(beast, facing, posesFor(beast.stride)[0]!),
        shade: shader(beast),
      };
      const pixels = castModel(model, projection(beast), large);
      await writeCast(path.join(dir, `${beast.id}-${facing}.png`), pixels, FRAME_PX * large);
    }
  }
}
