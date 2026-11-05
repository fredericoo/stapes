import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { PX_PER_HEIGHT, elevationScreenOffset } from "../app/lib/geometry";
import { HUMAN_PARTS, humanPart, type PartOn } from "../app/lib/humanParts";
import { FRAME_PX, SHEET_FACINGS, SHEET_POSES, SKIN_TONES } from "../app/lib/humanSprite";
import type { Direction } from "../app/lib/types";

const TILESETS = path.resolve(import.meta.dirname, "..", "data", "tilesets");
const OUT = path.join(TILESETS, "human_hats.png");
const PREVIEW = process.env.PREVIEW;

const BLOCK_W = SHEET_POSES.length * FRAME_PX;
const BLOCK_H = SHEET_FACINGS.length * FRAME_PX;
const SUPERSAMPLE = 6;
const COVERAGE = 0.5;
const MARCH_STEP = 0.04;
/** Every model fits in a sphere this wide about the point this far above the head's centre; rays are marched only inside it. */
const BOUND_R = 5.5;
const BOUND_LIFT = 1.5;
const NORMAL_EPS = 0.05;
const AMBIENT = 0.2;
const DIFFUSE = 0.85;
const PREVIEW_SCALE = 12;
const PREVIEW_BACKDROP = "#5a8c5a";

/** The head is a sphere about this many pixels across its radius; the bald head draws it as a 3×3 blob. */
const HEAD_R = 1.55;
/** Everything a hat models in front of the head and below this height is cut away, so it opens towards the face. */
const BROW = 0.85;
const FACE_BACK = 0.35;
const LIGHT = normalise([0.1, 0.45, 1]);

const OUTLINE = "#2e222f";
const BROWN = ["#45293f", "#6e2727", "#9e4539"];
const STEEL = ["#3e3546", "#7f708a", "#9babb2", "#c7dcd0"];
const GREEN = ["#165a4c", "#239063", "#1ebc73", "#91db69"];
const RED = ["#ae2334", "#e83b3b"];
const WOLF = ["#3e3546", "#694f62", "#7f708a", "#9babb2"];
const PALE = ["#7f708a", "#9babb2", "#ffffff"];
const BLACK = [OUTLINE];

type Vec = readonly [number, number, number];
type Sdf = (p: Vec) => number;
type Axes = { fw: Vec; lat: Vec; up: Vec };

/** `weight` lets a thin part (an ear, a feather) take a pixel it covers less than half of. */
type Solid = { sdf: Sdf; ramp: readonly string[]; weight?: number };

type HatModel = {
  solids: (head: Vec, axes: Axes) => Solid[];
  opensToFace: boolean;
  /**
   * Seen face-on the head is three pixels wide, which can lose a hat's whole
   * shape. Mirroring the screen across its diagonal swaps world x and y and
   * keeps the height shear, so the east frames mirrored are a true south view.
   */
  southFromEast?: boolean;
};

const FACING: Record<Direction, Vec> = { s: [0, 1, 0], e: [1, 0, 0], w: [-1, 0, 0], n: [0, -1, 0] };

function add(a: Vec, b: Vec): Vec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec, k: number): Vec {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len(a: Vec): number {
  return Math.sqrt(dot(a, a));
}

function normalise(a: Vec): Vec {
  return scale(a, 1 / len(a));
}

function at(origin: Vec, ...terms: [Vec, number][]): Vec {
  return terms.reduce<Vec>((p, [axis, k]) => add(p, scale(axis, k)), origin);
}

function axesFor(facing: Direction): Axes {
  const fw = FACING[facing];
  const up: Vec = [0, 0, 1];
  const lat: Vec = [
    up[1] * fw[2] - up[2] * fw[1],
    up[2] * fw[0] - up[0] * fw[2],
    up[0] * fw[1] - up[1] * fw[0],
  ];
  return { fw, lat, up };
}

function local(p: Vec, c: Vec, { fw, lat, up }: Axes): Vec {
  const q: Vec = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  return [dot(q, fw), dot(q, lat), dot(q, up)];
}

function sphere(c: Vec, r: number): Sdf {
  return (p) => len([p[0] - c[0], p[1] - c[1], p[2] - c[2]]) - r;
}

/** Not an exact distance, but its sign and gradient are right, which is all the march and the shading read. */
function ellipsoid(c: Vec, radii: Vec, axes: Axes): Sdf {
  const smallest = Math.min(...radii);
  return (p) => {
    const q = local(p, c, axes);
    return (len([q[0] / radii[0], q[1] / radii[1], q[2] / radii[2]]) - 1) * smallest;
  };
}

function box(c: Vec, half: Vec, axes: Axes): Sdf {
  return (p) => {
    const q = local(p, c, axes);
    return Math.max(Math.abs(q[0]) - half[0], Math.abs(q[1]) - half[1], Math.abs(q[2]) - half[2]);
  };
}

function cone(base: Vec, axis: Vec, height: number, radius: number): Sdf {
  const a = normalise(axis);
  return (p) => {
    const q: Vec = [p[0] - base[0], p[1] - base[1], p[2] - base[2]];
    const along = dot(q, a);
    const radial = len(add(q, scale(a, -along)));
    return Math.max(-along, along - height, radial - radius * (1 - along / height));
  };
}

function cylinder(c: Vec, r: number, from: number, to: number): Sdf {
  return (p) => Math.max(Math.hypot(p[0] - c[0], p[1] - c[1]) - r, from - p[2], p[2] - to);
}

function above(sdf: Sdf, h: number): Sdf {
  return (p) => Math.max(sdf(p), h - p[2]);
}

function below(sdf: Sdf, h: number): Sdf {
  return (p) => Math.max(sdf(p), p[2] - h);
}

function minus(a: Sdf, b: Sdf): Sdf {
  return (p) => Math.max(a(p), -b(p));
}

function faceCut(head: Vec, axes: Axes): Sdf {
  const big = 6;
  return box(at(head, [axes.fw, big - FACE_BACK], [axes.up, BROW - big]), [big, big, big], axes);
}

/** Every part of `HUMAN_PARTS` on the hat layer needs a model here, so a new hat cannot be left undrawn. */
const HATS: Record<PartOn<"hat">, HatModel> = {
  "leather-cap": {
    opensToFace: true,
    solids: (c, x) => [
      { sdf: above(sphere(at(c, [x.up, 0.35]), HEAD_R + 0.35), c[2] + 0.2), ramp: BROWN },
      {
        sdf: below(ellipsoid(at(c, [x.fw, 1.3], [x.up, 1.05]), [1, 1.3, 0.28], x), c[2] + 1.25),
        ramp: BROWN,
        weight: 1.5,
      },
    ],
  },
  "iron-helmet": {
    opensToFace: true,
    solids: (c, x) => [
      { sdf: above(sphere(at(c, [x.up, 0.3]), HEAD_R + 0.4), c[2]), ramp: STEEL },
      { sdf: cylinder(c, HEAD_R + 0.55, c[2] - 0.15, c[2] + 0.3), ramp: STEEL },
      {
        sdf: box(at(c, [x.fw, HEAD_R + 0.45], [x.up, 0.6]), [0.28, 0.28, 0.6], x),
        ramp: STEEL,
        weight: 2,
      },
    ],
  },
  "robin-hood-hat": {
    opensToFace: true,
    solids: (c, x) => [
      {
        sdf: above(
          ellipsoid(at(c, [x.up, 0.75], [x.fw, 0.2]), [HEAD_R + 0.55, HEAD_R + 0.1, 1.45], x),
          c[2] + 0.25,
        ),
        ramp: GREEN,
      },
      {
        sdf: cone(at(c, [x.up, 1], [x.fw, 0.9]), add(x.fw, scale(x.up, 0.15)), 2.3, 0.6),
        ramp: GREEN,
        weight: 1.5,
      },
      {
        sdf: below(
          ellipsoid(at(c, [x.fw, -0.8], [x.up, 0.55]), [1.3, HEAD_R + 0.3, 0.75], x),
          c[2] + 1.1,
        ),
        ramp: GREEN,
      },
      {
        sdf: cone(
          at(c, [x.fw, -0.9], [x.lat, 1.35], [x.up, 0.9]),
          add(x.up, scale(x.fw, -0.8)),
          3.4,
          0.5,
        ),
        ramp: RED,
        weight: 2,
      },
    ],
  },
  "wolfskin-hood": {
    opensToFace: false,
    southFromEast: true,
    solids: (c, x) => [
      { sdf: above(sphere(at(c, [x.up, 0.35]), HEAD_R + 0.45), c[2] + 0.15), ramp: WOLF },
      {
        sdf: ellipsoid(at(c, [x.fw, 2], [x.up, 0.95]), [1.6, 0.85, 0.7], x),
        ramp: PALE,
        weight: 1.3,
      },
      { sdf: sphere(at(c, [x.fw, 3.4], [x.up, 1.05]), 0.45), ramp: BLACK, weight: 2 },
      ...[-1, 1].flatMap((s) => [
        {
          sdf: cone(
            at(c, [x.lat, s * 1.15], [x.up, 1.2], [x.fw, -0.3]),
            add(add(x.up, scale(x.fw, -0.2)), scale(x.lat, s * 0.3)),
            2.7,
            0.75,
          ),
          ramp: WOLF,
          weight: 2,
        },
        {
          sdf: sphere(at(c, [x.fw, 1.4], [x.lat, s * 0.85], [x.up, 1.2]), 0.35),
          ramp: BLACK,
          weight: 2,
        },
      ]),
    ],
  },
};

const read = (file: string) => PNG.sync.read(readFileSync(path.join(TILESETS, file)));

const hex = (data: Uint8Array, i: number) =>
  data[i + 3] === 0
    ? null
    : `#${[data[i]!, data[i + 1]!, data[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The colour of a pixel of block `block`, frame (`pose`, `row`), or null where it is transparent. */
function pixel(
  png: PNG,
  block: number,
  pose: number,
  row: number,
  x: number,
  y: number,
): string | null {
  const columns = Math.floor(png.width / BLOCK_W);
  const bx = (block % columns) * BLOCK_W + pose * FRAME_PX + x;
  const by = Math.floor(block / columns) * BLOCK_H + row * FRAME_PX + y;
  return hex(png.data, (by * png.width + bx) * 4);
}

const heads = read("human_heads.png");
const body = read("human_base.png");
const BALD = humanPart("bald").block;
const WITH_HAIR = (["short-hair", "beard", "long-hair"] as const).map((id) => humanPart(id).block);
const SKIN = new Set<string>(SKIN_TONES.default);

function headCentre(pose: number, row: number): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < FRAME_PX; y++) {
    for (let x = 0; x < FRAME_PX; x++) {
      if (!pixel(heads, BALD, pose, row, x, y)) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  }
  return [sx / n, sy / n];
}

/** The skin a hat that opens towards the face leaves showing: the face of every head with hair, not a bald scalp. */
function facePixels(pose: number, row: number): Set<number> {
  const face = new Set<number>();
  for (const block of WITH_HAIR) {
    for (let y = 0; y < FRAME_PX; y++) {
      for (let x = 0; x < FRAME_PX; x++) {
        const c = pixel(heads, block, pose, row, x, y);
        if (c && SKIN.has(c)) face.add(y * FRAME_PX + x);
      }
    }
  }
  return face;
}

/** Height moves the screen by this much per pixel of height, so a ray runs along its opposite. */
const RISE = elevationScreenOffset(1 / PX_PER_HEIGHT);

type Hit = { solid: number; t: number };

/** Where the ray through (sx, sy) enters and leaves the bounding sphere about `centre`, nearest the viewer first. */
function bounds(centre: Vec, sx: number, sy: number): [number, number] | null {
  const d: Vec = [-RISE.x, -RISE.y, 1];
  const o: Vec = [sx - centre[0], sy - centre[1], -centre[2]];
  const a = dot(d, d);
  const b = 2 * dot(d, o);
  const disc = b * b - 4 * a * (dot(o, o) - BOUND_R * BOUND_R);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function march(solids: Sdf[], centre: Vec, sx: number, sy: number): Hit | null {
  const span = bounds(centre, sx, sy);
  if (!span) return null;
  for (let k = Math.floor(span[0] / MARCH_STEP); k * MARCH_STEP > span[1]; k--) {
    const t = k * MARCH_STEP;
    const p: Vec = [sx - RISE.x * t, sy - RISE.y * t, t];
    for (let i = 0; i < solids.length; i++) if (solids[i]!(p) < 0) return { solid: i, t };
  }
  return null;
}

function brightness(sdf: Sdf, p: Vec): number {
  const g: Vec = [
    sdf([p[0] + NORMAL_EPS, p[1], p[2]]) - sdf([p[0] - NORMAL_EPS, p[1], p[2]]),
    sdf([p[0], p[1] + NORMAL_EPS, p[2]]) - sdf([p[0], p[1] - NORMAL_EPS, p[2]]),
    sdf([p[0], p[1], p[2] + NORMAL_EPS]) - sdf([p[0], p[1], p[2] - NORMAL_EPS]),
  ];
  return Math.min(1, Math.max(0, AMBIENT + DIFFUSE * dot(normalise(g), LIGHT)));
}

/** One frame of a hat, as colours by `y * FRAME_PX + x`. */
function drawFrame(
  model: HatModel,
  pose: number,
  row: number,
  facing: Direction,
): (string | null)[] {
  const [hx, hy] = headCentre(pose, row);
  const head: Vec = [hx, hy, 0];
  const axes = axesFor(facing);
  const cut = model.opensToFace ? faceCut(head, axes) : null;
  const parts = model.solids(head, axes).map((s) => (cut ? { ...s, sdf: minus(s.sdf, cut) } : s));
  const sdfs = [sphere(head, HEAD_R), ...parts.map((s) => s.sdf)];
  const bound: Vec = [hx, hy, BOUND_LIFT];

  const cells: { at: number; part: number; light: number }[] = [];
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < FRAME_PX; y++) {
    for (let x = 0; x < FRAME_PX; x++) {
      const counts = new Map<number, { n: number; light: number }>();
      let hat = 0;
      for (let j = 0; j < SUPERSAMPLE; j++) {
        for (let i = 0; i < SUPERSAMPLE; i++) {
          const sx = x + (i + 0.5) / SUPERSAMPLE;
          const sy = y + (j + 0.5) / SUPERSAMPLE;
          const hit = march(sdfs, bound, sx, sy);
          if (!hit || hit.solid === 0) continue;
          hat++;
          const part = hit.solid - 1;
          const p: Vec = [sx - RISE.x * hit.t, sy - RISE.y * hit.t, hit.t];
          const entry = counts.get(part) ?? { n: 0, light: 0 };
          entry.n++;
          entry.light += brightness(sdfs[hit.solid]!, p);
          counts.set(part, entry);
        }
      }
      let best = -1;
      let bestScore = 0;
      for (const [part, { n }] of counts) {
        const score = (n / samples) * (parts[part]!.weight ?? 1);
        if (score > bestScore) [best, bestScore] = [part, score];
      }
      if (best < 0 || (hat / samples < COVERAGE && bestScore < COVERAGE)) continue;
      const won = counts.get(best)!;
      cells.push({ at: y * FRAME_PX + x, part: best, light: won.light / won.n });
    }
  }

  const out: (string | null)[] = Array.from({ length: FRAME_PX * FRAME_PX }, () => null);
  const byRamp = new Map<readonly string[], typeof cells>();
  for (const cell of cells) {
    const ramp = parts[cell.part]!.ramp;
    byRamp.set(ramp, [...(byRamp.get(ramp) ?? []), cell]);
  }
  /** Ranking within the hat rather than thresholding the light means every hat uses all of its ramp. */
  for (const [ramp, group] of byRamp) {
    group.sort((a, b) => a.light - b.light);
    group.forEach((cell, rank) => {
      const level = Math.min(
        ramp.length - 1,
        Math.floor(((rank + 0.5) / group.length) * ramp.length),
      );
      out[cell.at] = ramp[level]!;
    });
  }

  if (model.opensToFace) for (const i of facePixels(pose, row)) out[i] = null;

  const outlined = [...out];
  for (let y = 0; y < FRAME_PX; y++) {
    for (let x = 0; x < FRAME_PX; x++) {
      if (out[y * FRAME_PX + x]) continue;
      const beside = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => {
        const nx = x + dx!;
        const ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= FRAME_PX || ny >= FRAME_PX) return false;
        const c = out[ny * FRAME_PX + nx];
        return c !== null && c !== OUTLINE;
      });
      const bodyHere = pixel(body, 0, pose, row, x, y);
      const againstBackground =
        !pixel(heads, BALD, pose, row, x, y) && (!bodyHere || bodyHere === OUTLINE);
      if (beside && againstBackground) outlined[y * FRAME_PX + x] = OUTLINE;
    }
  }
  return outlined;
}

function drawHat(model: HatModel): (string | null)[][][] {
  const frames = SHEET_FACINGS.map((facing, row) =>
    SHEET_POSES.map((_, pose) => drawFrame(model, pose, row, facing)),
  );
  if (!model.southFromEast) return frames;
  const south = SHEET_FACINGS.indexOf("s");
  const east = SHEET_FACINGS.indexOf("e");
  frames[south] = SHEET_POSES.map((_, pose) =>
    mirrorEastToSouth(frames[east]![pose]!, pose, south, east),
  );
  return frames;
}

/** Transposes the east frame about its head, with the offset that lays the east head blob on the south one. */
function mirrorEastToSouth(east: (string | null)[], pose: number, south: number, eastRow: number) {
  const blob = (row: number) => {
    const cells: [number, number][] = [];
    for (let y = 0; y < FRAME_PX; y++)
      for (let x = 0; x < FRAME_PX; x++)
        if (pixel(heads, BALD, pose, row, x, y)) cells.push([x, y]);
    return cells;
  };
  const target = new Set(blob(south).map(([x, y]) => y * FRAME_PX + x));
  let best = { overlap: -1, ox: 0, oy: 0 };
  for (let ox = -4; ox <= 4; ox++) {
    for (let oy = -4; oy <= 4; oy++) {
      const overlap = blob(eastRow).filter(([x, y]) =>
        target.has((x + oy) * FRAME_PX + y + ox),
      ).length;
      if (overlap > best.overlap) best = { overlap, ox, oy };
    }
  }
  const out: (string | null)[] = Array.from({ length: FRAME_PX * FRAME_PX }, () => null);
  for (let y = 0; y < FRAME_PX; y++) {
    for (let x = 0; x < FRAME_PX; x++) {
      const c = east[y * FRAME_PX + x];
      const nx = y + best.ox;
      const ny = x + best.oy;
      if (c && nx >= 0 && ny >= 0 && nx < FRAME_PX && ny < FRAME_PX) out[ny * FRAME_PX + nx] = c;
    }
  }
  return out;
}

/** `people.png`'s palette and transparency, which every `human_*.png` is indexed with. */
function peoplePalette(): { colours: string[]; chunks: Buffer[] } {
  const bytes = readFileSync(path.join(TILESETS, "people.png"));
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  for (let i = 8; i < bytes.length;) {
    const size = bytes.readUInt32BE(i);
    const type = bytes.toString("ascii", i + 4, i + 8);
    if (type === "PLTE") plte = bytes.subarray(i, i + 12 + size);
    if (type === "tRNS") trns = bytes.subarray(i, i + 12 + size);
    i += 12 + size;
  }
  if (!plte || !trns) throw new Error("people.png is not indexed");
  const colours: string[] = [];
  for (let k = 0; k < (plte.length - 12) / 3; k++) {
    const rgb = [plte[8 + k * 3]!, plte[9 + k * 3]!, plte[10 + k * 3]!];
    const opaque = k >= trns.length - 12 || trns[8 + k] === 255;
    colours.push(opaque ? `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` : "");
  }
  return { colours, chunks: [plte, trns] };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}

/** pngjs only writes RGBA, and the human sheets stay indexed, so the PNG is assembled here. */
function writeIndexed(file: string, width: number, height: number, colours: (string | null)[]) {
  const { colours: palette, chunks } = peoplePalette();
  const index = new Map(palette.map((c, i) => [c, i]));
  const transparent = palette.indexOf("");
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colours[y * width + x];
      const i = c ? index.get(c) : transparent;
      if (i === undefined) throw new Error(`${c} is not in people.png's palette`);
      raw[y * (width + 1) + 1 + x] = i;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 3, 0, 0, 0], 8);
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      ...chunks,
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function writePreview(dir: string, sheet: (string | null)[], width: number) {
  const hats = HUMAN_PARTS.filter((p) => p.layer === "hat");
  const shortHair = humanPart("short-hair").block;
  const w = SHEET_FACINGS.length * FRAME_PX;
  const h = hats.length * FRAME_PX;
  const png = new PNG({ width: w * PREVIEW_SCALE, height: h * PREVIEW_SCALE });
  hats.forEach((part, r) => {
    SHEET_FACINGS.forEach((_, row) => {
      for (let y = 0; y < FRAME_PX; y++) {
        for (let x = 0; x < FRAME_PX; x++) {
          const hat = sheet[(row * FRAME_PX + y) * width + part.block * BLOCK_W + FRAME_PX + x];
          const c =
            hat ??
            pixel(heads, shortHair, 1, row, x, y) ??
            pixel(body, 0, 1, row, x, y) ??
            PREVIEW_BACKDROP;
          const n = Number.parseInt(c.slice(1), 16);
          for (let dy = 0; dy < PREVIEW_SCALE; dy++) {
            for (let dx = 0; dx < PREVIEW_SCALE; dx++) {
              const px = (row * FRAME_PX + x) * PREVIEW_SCALE + dx;
              const py = (r * FRAME_PX + y) * PREVIEW_SCALE + dy;
              const i = (py * png.width + px) * 4;
              png.data.set([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255], i);
            }
          }
        }
      }
    });
  });
  writeFileSync(path.join(dir, "hats.png"), PNG.sync.write(png));
}

const blocks = HUMAN_PARTS.filter((p) => p.layer === "hat");
const existing = read("human_hats.png");
const width = Math.max(existing.width, (Math.max(...blocks.map((p) => p.block)) + 1) * BLOCK_W);
const sheet: (string | null)[] = Array.from({ length: width * BLOCK_H }, () => null);
for (const part of blocks) {
  const frames = drawHat(HATS[part.id]);
  frames.forEach((row, r) =>
    row.forEach((frame, pose) =>
      frame.forEach((c, i) => {
        const x = part.block * BLOCK_W + pose * FRAME_PX + (i % FRAME_PX);
        const y = r * FRAME_PX + Math.floor(i / FRAME_PX);
        sheet[y * width + x] = c;
      }),
    ),
  );
  console.log(`drew ${part.id}`);
}
writeIndexed(OUT, width, BLOCK_H, sheet);
if (PREVIEW) writePreview(PREVIEW, sheet, width);
