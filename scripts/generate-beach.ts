import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef, type TileHeight, type TileSprite } from "../app/lib/types";
import type { Projection, Vec3 } from "./limb-caster";
import { castModel, outlineBelow, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET = "beach";
const FRAME_MS = 200;
const OUTLINE = 0;

const SAND = 19;
const SAND_GRIT = 27;
const SAND_DAMP = 18;
const SHELL = 28;
const SHELL_PINK = 14;
const PEBBLE = 25;
const PEBBLE_SHADE = 22;

const HULL_RAMP = [13, 11, 3, 2];
const HULL_INSIDE = [11, 3, 2];
const FRAME_RAMP = [13, 11, 3];
const SPLINTER = 18;
const IRON = 2;
const SEAM = 2;
const RIB_RAMP = [11, 3, 2];
const MAST_RAMP = [13, 11, 3, 2];
const SAIL_RAMP = [27, 25, 22, 8];
const PLANK_RAMP = [13, 11, 3];
const NAIL = 25;
const DRIFTWOOD_RAMP = [27, 25, 22, 8];
const ROPE_RAMP = [18, 13, 11, 3];

type Hit = { normal: Vec3; ramp: readonly number[]; flat?: number; darker?: number };

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** A fixed value in [0, 1) per integer pair, so every break and tear lands in the same place on every run. */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) + Math.imul(b | 0, 0x165667b1) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000;
}

/** Lit from the south-west, as every other block here: the top and the south are bright, the east dark. */
function shade(hit: Hit): number {
  if (hit.flat !== undefined) return hit.flat;
  const { normal, ramp } = hit;
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.8;
  const band = Math.floor(((across + 1) / 2) * ramp.length) + (hit.darker ?? 0);
  return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
}

type Segment = { from: Vec3; to: Vec3; radiusFrom: number; radiusTo: number };

/** The distance-to-axis test of a tapered capsule, and the normal out of it at `p`. */
function inCapsule(s: Segment, p: Vec3): Vec3 | null {
  const d: Vec3 = [s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]];
  const rel: Vec3 = [p[0] - s.from[0], p[1] - s.from[1], p[2] - s.from[2]];
  const lengthSq = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const t = Math.max(0, Math.min(1, (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / lengthSq));
  const axis: Vec3 = [s.from[0] + d[0] * t, s.from[1] + d[1] * t, s.from[2] + d[2] * t];
  const off: Vec3 = [p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]];
  const radius = s.radiusFrom + (s.radiusTo - s.radiusFrom) * t;
  return Math.hypot(...off) <= radius ? normalise(off) : null;
}

function scaled(s: Segment, k: number): Segment {
  return {
    from: [s.from[0] * k, s.from[1] * k, s.from[2] * k],
    to: [s.to[0] * k, s.to[1] * k, s.to[2] * k],
    radiusFrom: s.radiusFrom * k,
    radiusTo: s.radiusTo * k,
  };
}

/** A curve as a chain of capsules, one per step. */
function chain(points: Vec3[], radiusFrom: number, radiusTo: number): Segment[] {
  return points.slice(1).map((to, i) => ({
    from: points[i]!,
    to,
    radiusFrom: radiusFrom + ((radiusTo - radiusFrom) * i) / (points.length - 1),
    radiusTo: radiusFrom + ((radiusTo - radiusFrom) * (i + 1)) / (points.length - 1),
  }));
}

type Sampler = (p: Vec3, scale: number) => Hit | null;

function capsules(parts: { segments: Segment[]; ramp: readonly number[] }[]): Sampler {
  const byScale = new Map<number, { segment: Segment; ramp: readonly number[]; top: number }[]>();
  return (p, scale) => {
    if (p[2] < 0) return null;
    let list = byScale.get(scale);
    if (!list) {
      list = parts.flatMap((part) =>
        part.segments.map((s) => {
          const segment = scaled(s, scale);
          const top =
            Math.max(segment.from[2], segment.to[2]) +
            Math.max(segment.radiusFrom, segment.radiusTo);
          return { segment, ramp: part.ramp, top };
        }),
      );
      byScale.set(scale, list);
    }
    for (const { segment, ramp, top } of list) {
      if (p[2] > top) continue;
      const normal = inCapsule(segment, p);
      if (normal) return { normal, ramp };
    }
    return null;
  };
}

/**
 * A section of the ship's side lying on the sand: a curved shell of planks,
 * open towards the south and the sky so the viewer looks into it. The far
 * side stands tall at the north; the near side has broken away to the sand.
 * Every plank is a band of the shell's angle with its own broken ends, and
 * the frames that held them stand proud inside and stick out past the rim.
 */
const HULL = {
  x0: -15,
  x1: 7,
  centre: [0, 1.5, 2.6] as const,
  radius: 6.4,
  thickness: 1.2,
  opening: normalise([0, 0.65, 1]),
  plankRad: 0.24,
  frames: [-11, -5.5, 0, 4.5],
  frameHalf: 0.75,
};

function sampleHull(p: Vec3, scale: number): Hit | null {
  if (p[2] < 0) return null;
  const x = p[0] / scale;
  const dy = p[1] / scale - HULL.centre[1];
  const dz = p[2] / scale - HULL.centre[2];
  const r = Math.hypot(dy, dz);
  const radial: Vec3 = [0, dy / (r || 1), dz / (r || 1)];
  const inward: Vec3 = [0, -radial[1], -radial[2]];
  const facing = radial[1] * HULL.opening[1] + radial[2] * HULL.opening[2];
  /** Angle round the shell from its keel, the point that faces away from the opening; positive is the tall north side. */
  const side = radial[2] * HULL.opening[1] - radial[1] * HULL.opening[2];
  const angle = Math.atan2(side, -facing);
  const plank = Math.floor(angle / HULL.plankRad);
  const frame = HULL.frames.findIndex((f) => Math.abs(x - f) < HULL.frameHalf);
  const inner = HULL.radius - HULL.thickness;
  if (frame >= 0) {
    const reach = Math.PI / 2 + 0.15 + hash(frame, 11) * 0.35;
    if (angle > -1.3 && angle < reach && r <= HULL.radius - 0.3 && r >= inner - 1) {
      const end = Math.abs(x - HULL.frames[frame]!) > HULL.frameHalf - 0.3;
      return {
        normal: end ? [Math.sign(x - HULL.frames[frame]!), 0, 0] : inward,
        ramp: FRAME_RAMP,
      };
    }
  }
  const rimNorth = Math.PI / 2 - 0.1 - hash(plank, 7) * 0.45;
  if (angle > rimNorth || angle < -1.25 + hash(plank, 8) * 0.3) return null;
  const broken = angle > 1 ? 5 : 2.5;
  const west = HULL.x0 + hash(plank, 1) * broken;
  const east = HULL.x1 - hash(plank, 2) * broken;
  if (x < west || x > east) return null;
  if (r > HULL.radius || r < inner) return null;
  if (x - west < 0.4 || east - x < 0.4)
    return { normal: [0, 0, 1], ramp: HULL_RAMP, flat: SPLINTER };
  const along = angle / HULL.plankRad - plank;
  if (r < inner + HULL.thickness / 2) {
    if (along < 0.25) return { normal: inward, ramp: HULL_INSIDE, flat: SEAM };
    return { normal: inward, ramp: HULL_INSIDE, darker: plank & 1 };
  }
  if (along < 0.3) return { normal: radial, ramp: HULL_RAMP, flat: SEAM };
  return { normal: radial, ramp: HULL_RAMP, darker: plank & 1 };
}

/**
 * The bones of the ship's bow: a keel half sunk in the sand, a stem post
 * curling up at its east end, and ribs rising either side of it in a U that
 * narrows towards the bow. Each rib is snapped off at its own height, and two
 * strakes of planking still cling low on the south side.
 */
function ribSegments(): { segments: Segment[]; ramp: readonly number[] }[] {
  const keel = chain(
    [
      [-17, 0, 0.3],
      [-6, 0, 0.5],
      [2, 0, 0.7],
      [5, 0, 1.6],
      [6.6, 0, 4],
      [7.1, 0, 7],
      [6.6, 0, 9.5],
    ],
    1.3,
    0.8,
  );
  const ribs: Segment[] = [];
  const stations = [-14, -10, -6, -2, 2];
  for (const [i, x] of stations.entries()) {
    const halfWidth = 6.6 - Math.max(0, x + 4) * 0.45;
    const rise = 7.5 - Math.max(0, x + 4) * 0.3;
    for (const sign of [-1, 1]) {
      const reach = 0.9 + hash(i, sign + 5) * 1.2;
      const points: Vec3[] = [];
      for (let k = 0; k <= 8; k++) {
        const phi = (reach * k) / 8;
        points.push([
          x + (sign * Math.sin(phi * 0.7)) / 2,
          sign * halfWidth * Math.sin(phi),
          rise * (1 - Math.cos(phi)) + 0.4,
        ]);
      }
      ribs.push(...chain(points, 0.85, 0.6));
    }
  }
  const strakes: Segment[] = [
    { from: [-15, 5.4, 1.6], to: [-3, 5.6, 1.7], radiusFrom: 0.7, radiusTo: 0.7 },
    { from: [-13, 6.1, 3.2], to: [-8, 6.2, 3.4], radiusFrom: 0.65, radiusTo: 0.65 },
  ];
  return [
    { segments: keel, ramp: RIB_RAMP },
    { segments: ribs, ramp: RIB_RAMP },
    { segments: strakes, ramp: HULL_RAMP },
  ];
}

/**
 * The snapped mast on its side along x, splintered at its west end where the
 * pale inside of the wood shows, banded with iron, with the yard lying beside
 * it to the north. The torn sail is a height field spread from the yard up and
 * over the mast and down onto the sand south of it, with holes torn through.
 */
const MAST = { y: 3, z: 1.6, radius: 1.6, x0: -22, x1: 5, bands: [-12, -3.5, 2.5] };
const YARD = { y: -4.5, z: 0.8, radius: 0.85, x0: -19, x1: 3, bands: [] as number[] };
const SAIL = { north: YARD.y - 1.5, south: MAST.y + 4.5, thickness: 0.35 };

function sailHeight(x: number, y: number): number | null {
  if (y < SAIL.north || y > SAIL.south) return null;
  const t = (y - SAIL.north) / (SAIL.south - SAIL.north);
  /** The free edge runs on a slant, so the sail reads as torn away rather than as a sheet laid square. */
  const west = -16 + t * 7 + hash(Math.floor(y * 1.5), 3) * 3;
  const east = 0 - t * 5 + hash(Math.floor(y), 4) * 2;
  if (x < west || x > east) return null;
  if (hash(Math.floor(x / 2), Math.floor(y / 1.5)) < 0.16) return null;
  const overMast = MAST.z + MAST.radius + 0.3;
  const yardTop = YARD.z + YARD.radius + 0.2;
  const ridge =
    y < MAST.y
      ? yardTop + (overMast - yardTop) * ((y - SAIL.north) / (MAST.y - SAIL.north)) ** 2
      : overMast * (1 - ((y - MAST.y) / (SAIL.south - MAST.y)) ** 0.7);
  const folds = 0.8 * Math.sin(x * 0.8 + y * 0.4) * Math.min(1, Math.abs(y - MAST.y) / 3);
  return Math.max(0.3, ridge + folds);
}

function sampleMast(p: Vec3, scale: number): Hit | null {
  if (p[2] < 0) return null;
  const [x, y, z] = [p[0] / scale, p[1] / scale, p[2] / scale];
  const sail = sailHeight(x, y);
  if (sail !== null && Math.abs(z - sail) <= SAIL.thickness) {
    const dx = (sailHeight(x + 0.4, y) ?? sail) - (sailHeight(x - 0.4, y) ?? sail);
    const dy = (sailHeight(x, y + 0.4) ?? sail) - (sailHeight(x, y - 0.4) ?? sail);
    return { normal: normalise([-dx / 0.8, -dy / 0.8, 1]), ramp: SAIL_RAMP };
  }
  for (const spar of [MAST, YARD]) {
    const angle = Math.atan2(z - spar.z, y - spar.y);
    const splinter = spar === MAST ? hash(Math.floor(angle * 2.5 + 8), 9) * 3.5 : 0;
    if (x < spar.x0 + splinter || x > spar.x1) continue;
    const off = Math.hypot(y - spar.y, z - spar.z);
    if (off > spar.radius) continue;
    if (spar === MAST && x - spar.x0 - splinter < 0.6)
      return { normal: [-1, 0, 0], ramp: MAST_RAMP, flat: SPLINTER };
    const normal = normalise([0, y - spar.y, z - spar.z]);
    if (spar.bands.some((b) => Math.abs(x - b) < 0.5))
      return { normal, ramp: MAST_RAMP, flat: IRON };
    return { normal, ramp: MAST_RAMP };
  }
  return null;
}

type Plank = {
  at: [number, number];
  angle: number;
  length: number;
  width: number;
  z: number;
  nails: boolean;
};

const PLANK_FACES: Plank[][] = [
  [{ at: [4, 4], angle: -0.35, length: 8.5, width: 2, z: 0, nails: true }],
  [
    { at: [3, 5], angle: 0.5, length: 7, width: 1.8, z: 0, nails: false },
    { at: [4.5, 3.5], angle: -0.6, length: 7.5, width: 2, z: 0.9, nails: true },
  ],
  [
    { at: [2.5, 3], angle: -0.2, length: 5, width: 1.8, z: 0, nails: true },
    { at: [5.5, 6], angle: 1.1, length: 4.5, width: 1.6, z: 0, nails: false },
  ],
];

const PLANK_THICKNESS = 0.9;

function samplePlanks(face: readonly Plank[]): Sampler {
  return (p, scale) => {
    const [x, y, z] = [p[0] / scale, p[1] / scale, p[2] / scale];
    for (const plank of [...face].sort((a, b) => b.z - a.z)) {
      if (z < plank.z || z > plank.z + PLANK_THICKNESS) continue;
      const c = Math.cos(plank.angle);
      const s = Math.sin(plank.angle);
      const along = (x - plank.at[0]) * c + (y - plank.at[1]) * s;
      const across = -(x - plank.at[0]) * s + (y - plank.at[1]) * c;
      if (Math.abs(along) > plank.length / 2 || Math.abs(across) > plank.width / 2) continue;
      if (z > plank.z + PLANK_THICKNESS - 0.3) {
        const nail =
          plank.nails &&
          Math.abs(Math.abs(along) - plank.length / 2 + 0.9) < 0.45 &&
          Math.abs(across) < 0.45;
        return { normal: [0, 0, 1], ramp: PLANK_RAMP, flat: nail ? NAIL : PLANK_RAMP[0] };
      }
      const end = plank.length / 2 - Math.abs(along) < 0.35;
      const normal: Vec3 = end
        ? [Math.sign(along) * c, Math.sign(along) * s, 0]
        : [-Math.sign(across) * s, Math.sign(across) * c, 0];
      return { normal, ramp: PLANK_RAMP, darker: 1 };
    }
    return null;
  };
}

function driftwoodSegments(): { segments: Segment[]; ramp: readonly number[] }[] {
  const log = chain(
    [
      [-1.5, 6, 1.1],
      [1.5, 5.2, 1.2],
      [4.5, 3.6, 1.1],
      [7.5, 2.6, 0.9],
    ],
    1.25,
    0.8,
  );
  const branch = chain(
    [
      [3.2, 4.2, 1.3],
      [3.6, 2.4, 2],
      [3.4, 0.9, 2.4],
    ],
    0.6,
    0.4,
  );
  const root = chain(
    [
      [-1.5, 6, 1.1],
      [-2.2, 7.2, 1.2],
      [-2, 8.4, 0.6],
    ],
    0.7,
    0.45,
  );
  return [{ segments: [...log, ...branch, ...root], ramp: DRIFTWOOD_RAMP }];
}

/**
 * Three turns of rope, two side by side on the sand and one on top of them,
 * with a hole in the middle and a loose end running off to the south-east. A
 * rope is laid in strands, so a band one step darker winds round
 * the tube every quarter turn.
 */
function sampleRope(p: Vec3, scale: number): Hit | null {
  const [x, y, z] = [p[0] / scale, p[1] / scale, p[2] / scale];
  if (z < 0) return null;
  const centre = [3.8, 4];
  const turns = [
    { major: 3, z: 0.8 },
    { major: 1.95, z: 0.8 },
    { major: 2.5, z: 2 },
  ];
  for (const turn of [...turns].reverse()) {
    const dx = x - centre[0]!;
    const dy = y - centre[1]!;
    const d = Math.hypot(dx, dy);
    const ring: Vec3 = [dx - (dx / d) * turn.major, dy - (dy / d) * turn.major, z - turn.z];
    if (Math.hypot(...ring) > 0.95) continue;
    const around = Math.atan2(dy, dx);
    const twist = Math.atan2(ring[2], Math.hypot(ring[0], ring[1]) * Math.sign(d - turn.major));
    const strand = Math.floor(((around * 4 + twist) / Math.PI) * 2) % 2 === 0;
    return { normal: normalise(ring), ramp: ROPE_RAMP, darker: strand ? 1 : 0 };
  }
  const tail = inCapsule(
    { from: [5.8, 5, 0.85], to: [8.6, 7.4, 0.7], radiusFrom: 0.8 * scale, radiusTo: 0.7 * scale },
    [x * scale, y * scale, z * scale],
  );
  if (tail) return { normal: tail, ramp: ROPE_RAMP };
  return null;
}

type Prop = {
  id: string;
  name: string;
  height: TileHeight;
  cells: number;
  footprint?: { w: number; d: number };
  walkable?: boolean;
  sample: Sampler;
};

const BIG: Prop[] = [
  {
    id: "wreck-hull",
    name: "Broken hull",
    height: 4,
    cells: 5,
    footprint: { w: 3, d: 2 },
    walkable: false,
    sample: sampleHull,
  },
  {
    id: "wreck-ribs",
    name: "Ship's ribs",
    height: 4,
    cells: 5,
    footprint: { w: 3, d: 2 },
    walkable: false,
    sample: capsules(ribSegments()),
  },
  {
    id: "wreck-mast",
    name: "Broken mast",
    height: 1,
    cells: 5,
    footprint: { w: 4, d: 2 },
    walkable: false,
    sample: sampleMast,
  },
];

const SMALL: Prop[] = [
  {
    id: "driftwood",
    name: "Driftwood",
    height: 1,
    cells: 2,
    walkable: false,
    sample: capsules(driftwoodSegments()),
  },
  { id: "rope-coil", name: "Coil of rope", height: 1, cells: 2, sample: sampleRope },
];

/**
 * The desert's sand colour with damp streaks the tide left and a little pale
 * grit: the palette pass snaps every pixel to `STAPES_PALETTE`, which has no
 * paler yellow, so the beach cannot have a sand colour of its own. Faces with shells or pebbles keep them off the
 * border, so the scatter can put any face beside any other.
 */
const SAND_FACES: readonly (readonly string[])[] = [
  ["........", "........", "........", "........", "........", "........", "........", "........"],
  ["........", "........", "........", "...sS...", "...SS...", "........", "........", "........"],
  ["........", "........", ".....p..", "....pq..", "........", "..p.....", "........", "........"],
  ["........", "........", "..dd....", "....ddd.", "........", "........", "........", "........"],
  ["........", "........", "........", "........", "...ddd..", ".dd.....", "........", "........"],
  ["........", "........", "..S.....", "........", "........", ".....s..", "........", "........"],
  ["........", ".dd.....", "...dd...", "........", "........", "....dd..", "......d.", "........"],
];
const PLAIN_REPEATS = 24;
const GRIT_SHARE = 0.06;

const SAND_INK: Record<string, number> = {
  s: SHELL_PINK,
  S: SHELL,
  p: PEBBLE,
  q: PEBBLE_SHADE,
  d: SAND_DAMP,
};

function sandPixel(face: number, x: number, y: number): number {
  const key = SAND_FACES[face]![y]![x]!;
  if (key !== ".") return SAND_INK[key]!;
  /** The plain face is most of the beach, so grit on it would repeat in every cell and tile into a grid. */
  if (face === 0) return SAND;
  return hash(face * 8 + x, y) < GRIT_SHARE ? SAND_GRIT : SAND;
}

const SAND_ROW = 0;
const SMALL_ROW = 1;
const BIG_ROW = 3;
const SMALL_COLUMNS = PLANK_FACES.length + SMALL.length;

function cellSprite(rect: { x: number; y: number; w: number; h: number }): TileSprite {
  return {
    frames: [{ sprite: { rect, base: { x: rect.w - 1, y: rect.h - 1 } }, durationMs: FRAME_MS }],
  };
}

function projection(cells: number): Projection {
  const spritePx = cells * CELL_SIZE;
  return { spritePx, groundPx: spritePx - CELL_SIZE, topPx: spritePx - 1 };
}

async function cast(
  sheet: PNG,
  sample: Sampler,
  cells: number,
  at: { x: number; y: number },
  name: string,
) {
  const size = cells * CELL_SIZE;
  const model = { sample, shade };
  const pixels = outlineBelow(castModel(model, projection(cells)), size, OUTLINE);
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i]! < 0) continue;
    paint(
      sheet,
      at.x * CELL_SIZE + (i % size),
      at.y * CELL_SIZE + Math.floor(i / size),
      pixels[i]!,
    );
  }
  /** `PREVIEW=<dir>` also writes each prop cast four times larger, to look at its shape before it is pixels. */
  if (process.env.PREVIEW) {
    await writeCast(
      path.join(process.env.PREVIEW, `${name}-4x.png`),
      castModel(model, projection(cells), 4),
      size * 4,
    );
  }
}

function tiles(): TileDef[] {
  const sand: TileDef = {
    id: "beach-sand",
    name: "Beach sand",
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: SAND_ROW },
    scatter: [
      ...SAND_FACES.map((_, i) => cellSprite({ x: i, y: 0, w: 1, h: 1 })),
      ...Array.from({ length: PLAIN_REPEATS }, () => cellSprite({ x: 0, y: 0, w: 1, h: 1 })),
    ],
  };
  const planks: TileDef = {
    id: "wreck-planks",
    name: "Broken planks",
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: SMALL_ROW },
    lightPassing: true,
    scatter: PLANK_FACES.map((_, i) => cellSprite({ x: i * 2, y: 0, w: 2, h: 2 })),
  };
  const small = SMALL.map((prop, i): TileDef => ({
    id: prop.id,
    name: prop.name,
    height: prop.height,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: (PLANK_FACES.length + i) * 2, y: SMALL_ROW },
    lightPassing: true,
    ...(prop.walkable === false ? { walkable: false } : {}),
    sprite: cellSprite({ x: 0, y: 0, w: 2, h: 2 }),
  }));
  let column = 0;
  const big = BIG.map((prop): TileDef => {
    const tile: TileDef = {
      id: prop.id,
      name: prop.name,
      height: prop.height,
      type: "simple",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: TILESET, x: column, y: BIG_ROW },
      lightPassing: true,
      walkable: false,
      footprint: prop.footprint,
      sprite: cellSprite({ x: 0, y: 0, w: prop.cells, h: prop.cells }),
    };
    column += prop.cells;
    return tile;
  });
  return [sand, planks, ...small, ...big];
}

async function main() {
  const bigCells = BIG.reduce((sum, prop) => sum + prop.cells, 0);
  const width = Math.max(SAND_FACES.length, SMALL_COLUMNS * 2, bigCells) * CELL_SIZE;
  const height = (BIG_ROW + Math.max(...BIG.map((prop) => prop.cells))) * CELL_SIZE;
  const sheet = new PNG({ width, height });
  /** pngjs leaves the buffer opaque black; the props need a transparent backdrop. */
  sheet.data.fill(0);
  for (let face = 0; face < SAND_FACES.length; face++) {
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++)
        paint(sheet, face * CELL_SIZE + x, y, sandPixel(face, x, y));
    }
  }
  for (const [i, face] of PLANK_FACES.entries()) {
    await cast(sheet, samplePlanks(face), 2, { x: i * 2, y: SMALL_ROW }, `wreck-planks-${i}`);
  }
  for (const [i, prop] of SMALL.entries()) {
    await cast(
      sheet,
      prop.sample,
      prop.cells,
      { x: (PLANK_FACES.length + i) * 2, y: SMALL_ROW },
      prop.id,
    );
  }
  let column = 0;
  for (const prop of BIG) {
    await cast(sheet, prop.sample, prop.cells, { x: column, y: BIG_ROW }, prop.id);
    column += prop.cells;
  }
  await writeTileset(TILESET, "Beach", sheet, tiles());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
