import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type Direction, type TileDef, type TileSprite } from "../app/lib/types";
import { paint, paintRgba, readJson, type Rgba, writeTileset } from "./tileset-output";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const TILESET = "snow-beasts";

const WOLF_ROWS = 5;
const YETI_ROW = WOLF_ROWS;
const YETI_CELLS = 6;
/** The standing cell is one in from the sprite's south-east corner, which leaves room for the arm on that side. */
const YETI_BASE = { x: YETI_CELLS - 2, y: YETI_CELLS - 2 };
const YETI_PX = YETI_CELLS * CELL_SIZE;
const SHEET_CELLS = { w: 3 * YETI_CELLS, h: WOLF_ROWS + 4 * YETI_CELLS };

/** The wolf's coat, shade by shade, in the colours of `snow` and the snow on a pine. Its outline is kept. */
const WOLF_COAT: Record<string, string> = {
  "#3e3546": "#9babb2",
  "#694f62": "#ffffff",
  "#7f708a": "#ffffff",
  "#9babb2": "#affcdb",
};

/** The wolf's darkest fur is its outline colour, so the same colour inside the body is fur and is lightened. */
const WOLF_OUTLINE = "#2e222f";
const WOLF_DEEP_FUR = "#7f708a";

function rgba(hex: string): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const AROUND = [...NEIGHBOURS, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

function spriteRects(tile: TileDef): { x: number; y: number; w: number; h: number }[] {
  const sets = [tile.sprites, ...Object.values(tile.states ?? {}).map((s) => s.sprites)];
  return sets.flatMap((set) =>
    Object.values(set ?? {}).flatMap((sprite: TileSprite) =>
      sprite.frames.map((f) => f.sprite.rect),
    ),
  );
}

/**
 * The snow wolf keeps the wolf's frames and their layout, so its sprites are
 * the wolf's own rects read from another sheet. Only the pixels inside those
 * rects are copied: the wolf's rows of `animals.png` hold the rabbit too.
 */
async function drawWolf(sheet: PNG, wolf: TileDef) {
  const animals = PNG.sync.read(await fs.readFile(path.join(DATA, "tilesets", "animals.png")));
  for (const rect of spriteRects(wolf)) {
    const w = rect.w * CELL_SIZE;
    const h = rect.h * CELL_SIZE;
    const x0 = (wolf.anchor.x + rect.x) * CELL_SIZE;
    const y0 = (wolf.anchor.y + rect.y) * CELL_SIZE;
    const hexAt = (x: number, y: number): string | null => {
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const i = (animals.width * (y0 + y) + x0 + x) << 2;
      if (animals.data[i + 3] === 0) return null;
      return `#${[0, 1, 2].map((c) => animals.data[i + c]!.toString(16).padStart(2, "0")).join("")}`;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const hex = hexAt(x, y);
        if (!hex) continue;
        const inside = NEIGHBOURS.every(([dx, dy]) => hexAt(x + dx, y + dy) !== null);
        const fur = hex === WOLF_OUTLINE && inside ? WOLF_DEEP_FUR : (WOLF_COAT[hex] ?? hex);
        paintRgba(sheet, rect.x * CELL_SIZE + x, rect.y * CELL_SIZE + y, rgba(fur));
      }
    }
  }
}

type Vec3 = [number, number, number];

/** What a ray met: fur, the bare skin of the hands, feet and face, or a horn. */
type Part = "fur" | "skin" | "horn";

/**
 * A body part in the yeti's own frame: `x` to its right hand, `y` ahead of
 * it, `z` up, in pixels from the middle of the cell it stands in. A part is a
 * rounded cone from `a` to `b`, or a ball when the two are one point. `limb`
 * names the parts whose fur runs together into one shape.
 */
type Bone = { a: Vec3; b: Vec3; ra: number; rb: number; part: Part; limb: number; squash?: Vec3 };

/** `step` is -1, 0 or 1: the left leg ahead, standing, or the right leg ahead. The arms swing against the legs. */
function yetiBones(step: number): Bone[] {
  const stride = 1.9 * step;
  const swing = -1.5 * step;
  const bob = step === 0 ? 0 : -0.4;
  const bones: Bone[] = [];
  const add = (limb: number, part: Part, a: Vec3, b: Vec3, ra: number, rb: number, squash?: Vec3) =>
    bones.push({ a, b, ra, rb, part, limb, squash });

  add(0, "fur", [0, -0.6, 5 + bob], [0, -0.6, 5 + bob], 3.8, 3.8);
  add(0, "fur", [0, -0.4, 6.2 + bob], [0, 1.2, 9.6 + bob], 4.6, 5);
  add(0, "fur", [0, -1.2, 11 + bob], [0, -1.2, 11 + bob], 3.4, 3.4);
  add(0, "fur", [-5.6, 0.8, 10 + bob], [5.6, 0.8, 10 + bob], 3.1, 3.1);

  add(1, "fur", [0, 3.5, 11.3 + bob], [0, 3.5, 11.3 + bob], 2.9, 2.9);
  add(1, "fur", [0, 4.9, 10.2 + bob], [0, 4.9, 10.2 + bob], 1.9, 1.9);
  for (const side of [-1, 1]) {
    add(1, "horn", [1.9 * side, 3.2, 13.2 + bob], [3.9 * side, 3.6, 15.6 + bob], 1, 0.35);
  }

  for (const side of [-1, 1]) {
    const reach = swing * side;
    const limb = side > 0 ? 3 : 2;
    const elbow: Vec3 = [9.6 * side, 1 + reach * 0.5, 7 + bob];
    const wrist: Vec3 = [8.6 * side, 4.6 + reach, 3.4];
    add(limb, "fur", [6.2 * side, 0.8, 10 + bob], elbow, 2.7, 2.4);
    add(limb, "fur", elbow, wrist, 2.5, 3.1);
    add(limb, "skin", [8.4 * side, 5.6 + reach, 2.4], [8.4 * side, 5.6 + reach, 2.4], 2.5, 2.5);
  }

  for (const side of [-1, 1]) {
    const pace = stride * side;
    const limb = side > 0 ? 5 : 4;
    add(limb, "fur", [3 * side, -0.4, 5 + bob], [3.8 * side, 0.3 + pace, 2.2], 2.8, 2.4);
    add(limb, "skin", [3.9 * side, 2 + pace, 1], [3.9 * side, 2 + pace, 1], 1, 1, [2.1, 3, 1.2]);
  }
  return bones.map((bone) => ({
    ...bone,
    a: grown(bone.a),
    b: grown(bone.b),
    ra: bone.ra * YETI_SCALE,
    rb: bone.rb * YETI_SCALE,
    squash: bone.squash && grown(bone.squash),
  }));
}

/** The bones are written at the size of a tall man and the yeti is this much bigger, which is about the cyclops's bulk. */
const YETI_SCALE = 1.1;

function grown(v: Vec3): Vec3 {
  return [v[0] * YETI_SCALE, v[1] * YETI_SCALE, v[2] * YETI_SCALE];
}

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const ease = (t: number) => t * t * (3 - 2 * t);
  const fx = ease(x - xi);
  const fy = ease(y - yi);
  const fz = ease(z - zi);
  let total = 0;
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        total += weight * hash3(xi + dx, yi + dy, zi + dz);
      }
    }
  }
  return total;
}

function boneDistance(bone: Bone, p: Vec3): number {
  if (bone.squash) {
    const [sx, sy, sz] = bone.squash;
    const k = Math.hypot((p[0] - bone.a[0]) / sx, (p[1] - bone.a[1]) / sy, (p[2] - bone.a[2]) / sz);
    return (k - 1) * Math.min(sx, sy, sz);
  }
  const dx = bone.b[0] - bone.a[0];
  const dy = bone.b[1] - bone.a[1];
  const dz = bone.b[2] - bone.a[2];
  const px = p[0] - bone.a[0];
  const py = p[1] - bone.a[1];
  const pz = p[2] - bone.a[2];
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / lengthSq));
  return Math.hypot(px - dx * t, py - dy * t, pz - dz * t) - (bone.ra + (bone.rb - bone.ra) * t);
}

/** How far two fur surfaces reach towards each other where they meet, which is what joins a shoulder to a chest without a crease. */
const BLEND_PX = 1.1;
/** Fur is the surface pushed in and out by noise: `FUR_DEPTH_PX` deep, in clumps about `1 / FUR_GRAIN` pixels across. */
const FUR_DEPTH_PX = 0.3;
const FUR_GRAIN = 0.75;

type Field = { distance: number; bone: Bone };

const LIMBS = 6;

/**
 * Fur blends only with fur of its own limb, so an arm stays a shape of its
 * own in front of the chest and the render can draw a line round it.
 */
function yetiField(bones: readonly Bone[], p: Vec3): Field {
  const fur = new Array<number>(LIMBS).fill(Infinity);
  const furBone = new Array<Bone>(LIMBS);
  const nearest = new Array<number>(LIMBS).fill(Infinity);
  let best = Infinity;
  let bestBone = bones[0]!;
  for (const bone of bones) {
    const d = boneDistance(bone, p);
    if (bone.part !== "fur") {
      if (d < best) {
        best = d;
        bestBone = bone;
      }
      continue;
    }
    const limb = bone.limb;
    if (d < nearest[limb]!) {
      nearest[limb] = d;
      furBone[limb] = bone;
    }
    const so = fur[limb]!;
    if (so === Infinity) {
      fur[limb] = d;
      continue;
    }
    const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (so - d)) / BLEND_PX));
    fur[limb] = so + (d - so) * h - BLEND_PX * h * (1 - h);
  }
  const rough =
    FUR_DEPTH_PX * (noise3(p[0] * FUR_GRAIN, p[1] * FUR_GRAIN, p[2] * FUR_GRAIN) - 0.5) * 2;
  for (let limb = 0; limb < LIMBS; limb++) {
    const d = fur[limb]! - rough;
    if (d < best) {
      best = d;
      bestBone = furBone[limb]!;
    }
  }
  return { distance: best, bone: bestBone };
}

type Facing = { ahead: [number, number]; side: [number, number] };

/** `ahead` is the way the yeti faces and `side` its right hand, both level unit vectors on the map. */
const FACINGS: Record<Direction, Facing> = {
  n: { ahead: [0, -1], side: [1, 0] },
  e: { ahead: [1, 0], side: [0, 1] },
  s: { ahead: [0, 1], side: [-1, 0] },
  w: { ahead: [-1, 0], side: [0, -1] },
};

const MIDDLE = CELL_SIZE / 2;

function toLocal(facing: Facing, p: Vec3): Vec3 {
  const x = p[0] - MIDDLE;
  const y = p[1] - MIDDLE;
  return [x * facing.side[0] + y * facing.side[1], x * facing.ahead[0] + y * facing.ahead[1], p[2]];
}

/**
 * The face is the part of the head that turns this far towards `ahead`, below
 * `top`, a height in the bones' own size. It is bare skin and nothing else:
 * at this size a dark face reads as one, and eyes drawn on it do not.
 */
const FACE = { turn: 0.3, top: 13.1 };

type Sample = { index: number; depth: number; at: Vec3 };

const FUR_RAMP = [28, 28, 28, 27, 25, 22];
const SKIN_RAMP = [23, 23, 7, 7, 5];
const HORN_RAMP = [28, 29, 29, 30, 24];

/** The light comes from the south-west and from above, as it does on every other standing thing. */
const LIGHT: Vec3 = [-0.42, 0.5, 0.76];
const RAY: Vec3 = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)];
const HIT_PX = 0.02;
/** A step shorter than the distance the field reports, since noise makes the field overestimate. */
const STEP_SHARE = 0.6;
const NORMAL_PX = 0.35;
/** How far out along the normal the field is asked again; fur close by on that side means a crease, which is drawn darker. */
const CREASE_PX = 1.4;
const CREASE_WEIGHT = 0.3;
/** Noise added to the light before it is cut into bands, so a band's edge is ragged like the edge of a tuft. */
const TUFT_WEIGHT = 0.12;
const TUFT_GRAIN = 1.7;

function castYeti(bones: readonly Bone[], facing: Facing, u: number, v: number): Sample | null {
  const ground = YETI_BASE.x * CELL_SIZE;
  const top = ground - 1;
  const origin: Vec3 = [u - ground + top, v - ground + top, top];
  const field = (p: Vec3) => yetiField(bones, toLocal(facing, p));
  let travelled = 0;
  const limit = top * Math.sqrt(3);
  while (travelled < limit) {
    const p: Vec3 = [
      origin[0] + RAY[0] * travelled,
      origin[1] + RAY[1] * travelled,
      origin[2] + RAY[2] * travelled,
    ];
    const here = field(p);
    if (here.distance > HIT_PX) {
      travelled += Math.max(HIT_PX, here.distance * STEP_SHARE);
      continue;
    }
    const d = (dx: number, dy: number, dz: number) =>
      field([p[0] + dx, p[1] + dy, p[2] + dz]).distance;
    const raw: Vec3 = [
      d(NORMAL_PX, 0, 0) - d(-NORMAL_PX, 0, 0),
      d(0, NORMAL_PX, 0) - d(0, -NORMAL_PX, 0),
      d(0, 0, NORMAL_PX) - d(0, 0, -NORMAL_PX),
    ];
    const length = Math.hypot(...raw) || 1;
    const normal: Vec3 = [raw[0] / length, raw[1] / length, raw[2] / length];
    const local = toLocal(facing, p).map((c) => c / YETI_SCALE) as Vec3;
    const turn = toLocal(facing, [normal[0] + MIDDLE, normal[1] + MIDDLE, normal[2]])[1];
    let part = here.bone.part;
    if (here.bone.limb === 1 && part === "fur" && turn > FACE.turn && local[2] < FACE.top) {
      part = "skin";
    }
    const index = shade(part, p, normal, d);
    return { index, depth: travelled, at: p };
  }
  return null;
}

function shade(
  part: Part,
  p: Vec3,
  normal: Vec3,
  d: (dx: number, dy: number, dz: number) => number,
): number {
  const lit = Math.max(0, normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]);
  const open = Math.max(
    0,
    Math.min(1, d(normal[0] * CREASE_PX, normal[1] * CREASE_PX, normal[2] * CREASE_PX) / CREASE_PX),
  );
  const tuft =
    part === "fur" ? noise3(p[0] * TUFT_GRAIN, p[1] * TUFT_GRAIN, p[2] * TUFT_GRAIN) - 0.5 : 0;
  const tone = 0.2 + 0.8 * lit - (1 - open) * CREASE_WEIGHT + tuft * TUFT_WEIGHT;
  const ramp = part === "fur" ? FUR_RAMP : part === "skin" ? SKIN_RAMP : HORN_RAMP;
  const band = Math.floor((1 - Math.max(0, Math.min(0.999, tone))) * ramp.length);
  return ramp[band]!;
}

const SUPERSAMPLE = 4;
const OUTLINE = 0;
const SEAM = 0;
/** A pixel is drawn when this share of its samples met the yeti. */
const COVERAGE_SHARE = 0.4;
/**
 * The lines are a toon render's. One is drawn where the surface steps back
 * from the eye by more than `SEAM_DEPTH_PX` between one pixel and the next,
 * on the pixel that is further away, and only if there is air between the two
 * surfaces: somewhere on the straight line from one to the other the figure
 * is more than `SEAM_AIR_PX` away. An arm hanging in front of the chest has
 * air behind it. A shoulder running into the chest, a head sunk into the
 * shoulders and a slope seen nearly edge on have none, and get no line.
 */
const SEAM_DEPTH_PX = 2;
const SEAM_AIR_PX = 0.45;
const SEAM_PROBES = [0.25, 0.5, 0.75];

/** A pixel with fewer covered neighbours than this is a nub of fur noise on the silhouette and is cleared. */
const NUB_NEIGHBOURS = 2;

/**
 * One pose as palette indices, -1 where it is clear. Every pixel is the
 * colour most of its samples chose, with the toon lines over it and a dark
 * edge all round.
 */
function renderYeti(facing: Facing, step: number, scale = 1): Int16Array {
  const bones = yetiBones(step);
  const size = YETI_PX * scale;
  const colour = new Int16Array(size * size).fill(-1);
  const depth = new Float32Array(size * size);
  const point = new Array<Vec3>(size * size);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const votes = new Map<number, number>();
      let hits = 0;
      let nearest: Sample | null = null;
      for (let j = 0; j < SUPERSAMPLE; j++) {
        for (let i = 0; i < SUPERSAMPLE; i++) {
          const hit = castYeti(
            bones,
            facing,
            (u + (i + 0.5) / SUPERSAMPLE) / scale,
            (v + (j + 0.5) / SUPERSAMPLE) / scale,
          );
          if (!hit) continue;
          hits++;
          if (!nearest || hit.depth < nearest.depth) nearest = hit;
          votes.set(hit.index, (votes.get(hit.index) ?? 0) + 1);
        }
      }
      if (!nearest || hits < SUPERSAMPLE * SUPERSAMPLE * COVERAGE_SHARE) continue;
      const at = v * size + u;
      colour[at] = [...votes].sort((a, b) => b[1] - a[1])[0]![0];
      depth[at] = nearest.depth;
      point[at] = nearest.at;
    }
  }
  const covered = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && colour[y * size + x]! >= 0;
  const nubs: number[] = [];
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (!covered(u, v)) continue;
      const around = NEIGHBOURS.filter(([dx, dy]) => covered(u + dx, v + dy)).length;
      if (around < NUB_NEIGHBOURS) nubs.push(v * size + u);
    }
  }
  for (const at of nubs) colour[at] = -1;

  const airBetween = (from: Vec3, to: Vec3) =>
    SEAM_PROBES.some((t) => {
      const p: Vec3 = [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ];
      return yetiField(bones, toLocal(facing, p)).distance > SEAM_AIR_PX;
    });
  const out = colour.slice();
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const at = v * size + u;
      if (colour[at]! < 0) {
        if (NEIGHBOURS.some(([dx, dy]) => covered(u + dx, v + dy))) out[at] = OUTLINE;
        continue;
      }
      const behind = NEIGHBOURS.some(([dx, dy]) => {
        if (!covered(u + dx, v + dy)) return false;
        const other = (v + dy) * size + u + dx;
        return depth[at]! - depth[other]! > SEAM_DEPTH_PX && airBetween(point[at]!, point[other]!);
      });
      if (behind) out[at] = SEAM;
    }
  }
  /** A line one pixel long that touches no other line and no edge is noise, and takes its own colour back. */
  const lined = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && out[y * size + x] === SEAM;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const at = v * size + u;
      if (colour[at]! < 0 || out[at] !== SEAM) continue;
      const alone = AROUND.every(([dx, dy]) => !lined(u + dx, v + dy));
      if (alone) out[at] = colour[at]!;
    }
  }
  return out;
}

const YETI_FACINGS: readonly Direction[] = ["n", "e", "s", "w"];
const YETI_STEPS = [0, 1, -1] as const;
const STAND_MS = 200;
const STRIDE_MS = 240;

function yetiRect(facing: number, pose: number) {
  return { x: pose * YETI_CELLS, y: facing * YETI_CELLS, w: YETI_CELLS, h: YETI_CELLS };
}

function drawYeti(sheet: PNG) {
  for (const [f, facing] of YETI_FACINGS.entries()) {
    for (const [pose, step] of YETI_STEPS.entries()) {
      const pixels = renderYeti(FACINGS[facing], step);
      const rect = yetiRect(f, pose);
      const x0 = rect.x * CELL_SIZE;
      const y0 = (YETI_ROW + rect.y) * CELL_SIZE;
      pixels.forEach((index, at) => {
        if (index >= 0) paint(sheet, x0 + (at % YETI_PX), y0 + Math.floor(at / YETI_PX), index);
      });
    }
  }
}

function yetiSprites(poses: readonly number[], durationMs: number) {
  return Object.fromEntries(
    YETI_FACINGS.map((facing, f): [Direction, TileSprite] => [
      facing,
      {
        frames: poses.map((pose) => ({
          sprite: { rect: yetiRect(f, pose), base: YETI_BASE },
          durationMs,
        })),
      },
    ]),
  ) as Record<Direction, TileSprite>;
}

function tiles(wolf: TileDef): TileDef[] {
  const snowWolf: TileDef = {
    id: "snow-wolf",
    name: "Snow Wolf",
    height: wolf.height,
    type: wolf.type,
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: 0 },
    sprites: wolf.sprites,
    states: wolf.states,
  };
  const yeti: TileDef = {
    id: "yeti",
    name: "Yeti",
    height: 8,
    type: "directional",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: YETI_ROW },
    sprites: yetiSprites([0], STAND_MS),
    states: { moving: { sprites: yetiSprites([1, 0, 2, 0], STRIDE_MS) } },
  };
  return [snowWolf, yeti];
}

const PREVIEW_SCALE = 6;

async function writePreview(dir: string) {
  const size = YETI_PX * PREVIEW_SCALE;
  const out = new PNG({ width: size * YETI_FACINGS.length, height: size });
  out.data.fill(0);
  YETI_FACINGS.forEach((facing, f) => {
    renderYeti(FACINGS[facing], 0, PREVIEW_SCALE).forEach((index, at) => {
      if (index >= 0) paint(out, f * size + (at % size), Math.floor(at / size), index);
    });
  });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "yeti.png"), PNG.sync.write(out));
}

async function main() {
  const catalogue = await readJson<TileDef[]>(path.join(DATA, "tiles.json"));
  const wolf = catalogue.find((t) => t.id === "wolf");
  if (!wolf) throw new Error("no wolf to recolour");
  const sheet = new PNG({ width: SHEET_CELLS.w * CELL_SIZE, height: SHEET_CELLS.h * CELL_SIZE });
  sheet.data.fill(0);
  await drawWolf(sheet, wolf);
  drawYeti(sheet);
  await writeTileset(TILESET, "Snow Beasts", sheet, tiles(wolf));
  /** `PREVIEW=<dir>` also writes the standing pose of each facing six times larger, to judge the model before it is pixels. */
  if (process.env.PREVIEW) await writePreview(process.env.PREVIEW);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
