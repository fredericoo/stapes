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
  /** Ellipsoids sharing a group are one piece to `lines`; the rest are the body. */
  group?: string;
};

type Four = [number, number, number, number];

/**
 * `swing` is how far along the beast each paw is from under its hip, in the
 * order of `legs`. `lift`, for a beast with jointed `limb`s, is how far each
 * leg is folded off the ground, from 0 planted to 1 tucked mid-swing.
 */
export type Pose = {
  swing: Four;
  dropPx: number;
  lifts: boolean;
  lift?: Four;
  /** For a beast whose body moves rather than its legs, how far through the walk cycle, from 0 to 1. */
  phase?: number;
  /** For a beast with no legs, how high it holds its head off the ground. */
  raise?: number;
};

/** A joint of a leg drawn as a chain, swept to the next joint with its radius blended between them. */
export type LimbPoint = { at: Vec3; r: number; paw?: boolean };

/**
 * A body with no legs, swept through `points` like a leg. `part` and `group`
 * are asked of each segment, so markings and `lines` can follow it.
 */
export type Tube<P extends string> = {
  points: LimbPoint[];
  part: (segment: number) => P;
  group: (segment: number) => string;
};

/** `free` draws it after the outline and over empty pixels too, for something thinner than the model that sticks out of it. */
export type Mark = { at: Vec3; index: number; side: Vec3; free?: boolean };

type Hit<P extends string> = { part: P; normal: Vec3; group: string };

export type Beast<P extends string> = {
  id: string;
  name: string;
  /** The model, marks included, is drawn this many times larger; the walk still sinks it by a whole pixel. */
  size: number;
  topPx: number;
  /** Fixed, or worked out for each frame when the whole body moves. */
  trunk: Ellipsoid<P>[] | ((pose: Pose) => Ellipsoid<P>[]);
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
  marks: Mark[] | ((pose: Pose) => Mark[]);
  stepMs: number;
  /** Each leg as a chain of joints from the body to the paw, in place of the two-part leg the sizes above make. */
  limb?: (leg: number, pose: Pose, drop: number) => LimbPoint[];
  /** Its own frames, in place of the standing frame and two strides `posesFor` makes; the first is the standing one. */
  poses?: Pose[];
  /** The frames the walk plays, in order. */
  walk?: number[];
  /**
   * Draws the beast this many times longer along its body when it faces one of
   * these ways. Facing south or east it walks towards the viewer, and the
   * projection lays its length over its height until it reads as a short lump.
   */
  stretch?: Partial<Record<Facing, number>>;
  /**
   * Draws the outline colour where one piece (the body, a group of the trunk,
   * a leg) is seen next to another at least this many pixels nearer the
   * viewer, as the yeti's lines are, and none where two pieces join.
   */
  lines?: number;
  /** Bodies swept along a line for each frame, drawn under the trunk and over the legs. */
  tubes?: (pose: Pose) => Tube<P>[];
  /** Its frame, `cells` square with the beast standing on cell `base` from the top left, in place of four with the third. */
  frame?: Frame;
};

export type Frame = { cells: number; base: number };

const DEFAULT_FRAME: Frame = { cells: FRAME_CELLS, base: BASE_CELL };

export function frameOf<P extends string>(beast: Beast<P>): Frame & { px: number } {
  const frame = beast.frame ?? DEFAULT_FRAME;
  return { ...frame, px: frame.cells * CELL_SIZE };
}

function trunkOf<P extends string>(beast: Beast<P>, pose: Pose): Ellipsoid<P>[] {
  return typeof beast.trunk === "function" ? beast.trunk(pose) : beast.trunk;
}

function marksOf<P extends string>(beast: Beast<P>, pose: Pose): Mark[] {
  return typeof beast.marks === "function" ? beast.marks(pose) : beast.marks;
}

/** The walk's one-pixel sink in model units. */
function dropOf<P extends string>(beast: Beast<P>, pose: Pose): number {
  return pose.dropPx / beast.size;
}

export function posesOf<P extends string>(beast: Beast<P>): Pose[] {
  return beast.poses ?? posesFor(beast.stride);
}

export function walkOf<P extends string>(beast: Beast<P>): number[] {
  return beast.walk ?? [0, 1, 0, 2];
}

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

/** A joint as [along from under the hip or shoulder, height above the ground, radius]. */
export type Bone = [number, number, number];

type Gait = { planted: Bone[]; folded: Bone[] };

/**
 * A `limb` from two shapes of each leg. The shape blends from planted to
 * folded by the leg's `lift`, then the whole leg swings about its top joint so
 * the paw lands `swing` ahead. The walk's drop squashes it towards the ground,
 * so a planted paw stays down while the body sinks.
 */
export function jointedLimb(legs: [number, number][], gaits: { front: Gait; hind: Gait }) {
  return (leg: number, pose: Pose, drop: number): LimbPoint[] => {
    const [along, across] = legs[leg]!;
    const { planted, folded } = leg < 2 ? gaits.front : gaits.hind;
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
  };
}

const LANDING_LIFT = 0.3;
const PASSING = 0.4;

/**
 * A trot for a beast with jointed legs: each diagonal pair lands `stride`
 * ahead together, then passes under the body planted while the other pair
 * swings through folded. The body is a pixel lower on the landings. The first
 * frame stands on `standing`, and the walk plays the other four in order.
 */
export function trotPoses(stride: number, standing: Four): Pose[] {
  return [
    { swing: standing, dropPx: 0, lifts: false },
    {
      swing: [stride, -stride, -stride, stride],
      lift: [0, LANDING_LIFT, LANDING_LIFT, 0],
      dropPx: 1,
      lifts: true,
    },
    { swing: [-PASSING, PASSING, PASSING, -PASSING], lift: [0, 1, 1, 0], dropPx: 0, lifts: true },
    {
      swing: [-stride, stride, stride, -stride],
      lift: [LANDING_LIFT, 0, 0, LANDING_LIFT],
      dropPx: 1,
      lifts: true,
    },
    { swing: [PASSING, -PASSING, -PASSING, PASSING], lift: [1, 0, 0, 1], dropPx: 0, lifts: true },
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
  const hip: Vec3 = [along, across, beast.hipUp - dropOf(beast, pose)];
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

function legHit<P extends string>(
  beast: Beast<P>,
  p: Vec3,
  joint: Joint,
): Omit<Hit<P>, "group"> | null {
  const upper = fromSegment(p, joint.hip, joint.knee);
  if (Math.hypot(...upper.off) <= beast.thigh + (beast.knee - beast.thigh) * upper.t) {
    return { part: beast.fur, normal: upper.off };
  }
  const lower = fromSegment(p, joint.knee, joint.foot);
  const radius = beast.knee + (beast.foot - beast.knee) * lower.t;
  if (Math.hypot(...lower.off) > radius || p[2] < 0) return null;
  return { part: lower.t > 1 - beast.footShare ? beast.footPart : beast.fur, normal: lower.off };
}

function chainHit<P extends string>(
  beast: Beast<P>,
  p: Vec3,
  chain: LimbPoint[],
): Omit<Hit<P>, "group"> | null {
  for (let i = chain.length - 2; i >= 0; i--) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const { off, t } = fromSegment(p, a.at, b.at);
    if (Math.hypot(...off) > a.r + (b.r - a.r) * t) continue;
    return { part: b.paw && t > 0.5 ? beast.footPart : beast.fur, normal: off };
  }
  return null;
}

function tubeHit<P extends string>(p: Vec3, tube: Tube<P>): Hit<P> | null {
  const { points } = tube;
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const { off, t } = fromSegment(p, a.at, b.at);
    if (Math.hypot(...off) > a.r + (b.r - a.r) * t) continue;
    return { part: tube.part(i), normal: off, group: tube.group(i) };
  }
  return null;
}

export function sampler<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose) {
  const [ax, ay] = AHEAD[facing];
  const centre = CELL_SIZE / 2;
  const joints = beast.legs.map((_, i) => jointOf(beast, i, pose));
  const stretch = beast.stretch?.[facing] ?? 1;
  const chains = beast.limb
    ? beast.legs.map((_, i) => beast.limb!(i, pose, dropOf(beast, pose)))
    : null;
  const legTop = chains
    ? Math.max(...chains.flat().map((point) => point.at[2] + point.r))
    : beast.hipUp;
  const trunk = trunkOf(beast, pose);
  const tubes = beast.tubes?.(pose) ?? [];
  return (p: Vec3, scale: number): Hit<P> | null => {
    const x = (p[0] / scale - centre) / beast.size;
    const y = (p[1] / scale - centre) / beast.size;
    const along = (x * ax + y * ay) / stretch;
    const across = -x * ay + y * ax;
    const drop = dropOf(beast, pose);
    const up = p[2] / scale / beast.size + drop;
    const toWorld = ([nAlong, nAcross, nUp]: Vec3): Vec3 => {
      const n = nAlong / stretch;
      return normalise([n * ax - nAcross * ay, n * ay + nAcross * ax, nUp]);
    };

    for (let i = trunk.length - 1; i >= 0; i--) {
      const { part, at, radii, marking, group } = trunk[i]!;
      const d: Vec3 = [along - at[0], across - at[1], up - at[2]];
      if ((d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2 > 1) continue;
      return {
        part: marking?.(along, across, up) ?? part,
        normal: toWorld([d[0] / radii[0] ** 2, d[1] / radii[1] ** 2, d[2] / radii[2] ** 2]),
        group: group ?? "body",
      };
    }
    for (const tube of tubes) {
      const hit = tubeHit([along, across, up], tube);
      if (hit) return { ...hit, normal: toWorld(hit.normal) };
    }
    const legUp = up - drop;
    if (legUp < 0 || legUp > legTop) return null;
    if (chains) {
      for (const [leg, chain] of chains.entries()) {
        const hit = chainHit(beast, [along, across, legUp], chain);
        if (hit) return { part: hit.part, normal: toWorld(hit.normal), group: `leg ${leg}` };
      }
      return null;
    }
    for (const [leg, joint] of joints.entries()) {
      const hit = legHit(beast, [along, across, legUp], joint);
      if (hit) return { part: hit.part, normal: toWorld(hit.normal), group: `leg ${leg}` };
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
  const ground = frameOf(beast).base * CELL_SIZE;
  const seen: { u: number; v: number; index: number; free: boolean }[] = [];
  for (const { at, index, side, free } of marksOf(beast, pose)) {
    const [along, across, raised] = at;
    const outX = side[0] * ax - side[1] * ay;
    const outY = side[0] * ay + side[1] * ax;
    if (outX + outY + side[2] <= 0) continue;
    const up = raised * beast.size - pose.dropPx;
    const ahead = along * (beast.stretch?.[facing] ?? 1);
    const x = centre + (ahead * ax - across * ay) * beast.size;
    const y = centre + (ahead * ay + across * ax) * beast.size;
    seen.push({
      u: Math.floor(x + ground - up),
      v: Math.floor(y + ground - up),
      index,
      free: free ?? false,
    });
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

export const LINE_STEP_PX = 1 / 8;

/**
 * The drawn pixels that a neighbouring pixel of another piece covers from at
 * least `gap` pixels nearer. A ray down the middle of each pixel finds the
 * piece it shows and how high it meets it; on the projection's rays, higher
 * is nearer the viewer.
 */
function lineAt<P extends string>(
  sample: (p: Vec3, scale: number) => Hit<P> | null,
  { spritePx, groundPx, topPx }: { spritePx: number; groundPx: number; topPx: number },
  pixels: Int16Array,
  gap: number,
): number[] {
  const seen: ({ group: string; z: number } | null)[] = [];
  for (let v = 0; v < spritePx; v++) {
    for (let u = 0; u < spritePx; u++) {
      let found: { group: string; z: number } | null = null;
      for (let z = topPx; z >= 0 && !found; z -= LINE_STEP_PX) {
        const hit = sample([u + 0.5 - groundPx + z, v + 0.5 - groundPx + z, z], 1);
        if (hit) found = { group: hit.group, z };
      }
      seen.push(found);
    }
  }
  const lines: number[] = [];
  for (let n = 0; n < seen.length; n++) {
    const here = seen[n];
    if (!here || pixels[n]! < 0) continue;
    const u = n % spritePx;
    const neighbours = [
      u > 0 ? n - 1 : -1,
      u < spritePx - 1 ? n + 1 : -1,
      n - spritePx,
      n + spritePx,
    ];
    const covered = neighbours.some((m) => {
      const there = m >= 0 ? seen[m] : null;
      return there && there.group !== here.group && there.z - here.z >= gap;
    });
    if (covered) lines.push(n);
  }
  return lines;
}

function projection<P extends string>(beast: Beast<P>) {
  const { px, base } = frameOf(beast);
  return { spritePx: px, groundPx: base * CELL_SIZE, topPx: beast.topPx };
}

export function cast<P extends string>(beast: Beast<P>, facing: Facing, pose: Pose): Int16Array {
  const model = { sample: sampler(beast, facing, pose), shade: shader(beast) };
  const pixels = castModel(model, projection(beast));
  if (beast.lines !== undefined) {
    for (const n of lineAt(model.sample, projection(beast), pixels, beast.lines)) {
      pixels[n] = OUTLINE;
    }
  }
  const size = frameOf(beast).px;
  const marks = markPixels(beast, facing, pose);
  for (const { u, v, index, free } of marks) {
    if (!free && pixels[v * size + u]! >= 0) pixels[v * size + u] = index;
  }
  const onEdge = (n: number) =>
    n < size || n >= size * (size - 1) || n % size === 0 || n % size === size - 1;
  if (pixels.some((index, n) => index >= 0 && onEdge(n))) {
    throw new Error(`the ${beast.id} facing ${facing} runs off its frame`);
  }
  const edged = outlined(pixels, size);
  for (const { u, v, index, free } of marks) {
    if (free) edged[v * size + u] = index;
  }
  return edged;
}

function frameSprite(pose: number, row: number, durationMs: number, { cells, base }: Frame) {
  return {
    sprite: {
      rect: { x: pose * cells, y: row * cells, w: cells, h: cells },
      base: { x: base, y: base },
    },
    durationMs,
  };
}

/** `firstRow` counts frames of this size from the top of the sheet. */
export function facingFrames(
  firstRow: number,
  poses: readonly number[],
  durationMs: number,
  frame: Frame = DEFAULT_FRAME,
) {
  return Object.fromEntries(
    FACINGS.map((facing, row) => [
      facing,
      { frames: poses.map((pose) => frameSprite(pose, firstRow + row, durationMs, frame)) },
    ]),
  );
}

/** Paints every facing and walking pose of `beast` into `sheet`, a row of frames per facing from `firstRow`. */
export function paintBeast<P extends string>(sheet: PNG, beast: Beast<P>, firstRow: number) {
  const poses = posesOf(beast);
  const { px } = frameOf(beast);
  FACINGS.forEach((facing, f) => {
    const row = firstRow + f;
    poses.forEach((pose, column) => {
      cast(beast, facing, pose).forEach((index, n) => {
        if (index < 0) return;
        const x = column * px + (n % px);
        paint(sheet, x, row * px + Math.floor(n / px), index);
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
        sample: sampler(beast, facing, posesOf(beast)[0]!),
        shade: shader(beast),
      };
      const pixels = castModel(model, projection(beast), large);
      const { px } = frameOf(beast);
      await writeCast(path.join(dir, `${beast.id}-${facing}.png`), pixels, px * large);
    }
  }
}
