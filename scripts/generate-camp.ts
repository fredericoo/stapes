import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type Direction, type TileDef } from "../app/lib/types";
import type { Vec3 } from "./limb-caster";
import { castModel, type Model, writeCast } from "./model-caster";
import { paint, paintRgba, type Rgba, writeTileset } from "./tileset-output";

const TILESET_ID = "camp";
const SOURCE = path.join(import.meta.dirname, "..", "data", "tilesets", "tiny-ranch-tiles.png");

/**
 * The two canvas tents drawn in the tiny-ranch sheet, as pixel boxes there. They
 * sit half a cell off that sheet's grid, so they are copied onto this one,
 * each into the south-east corner of a three-cell square.
 */
const TENTS = [
  { id: "tent", name: "Tent", from: { x: 68, y: 220, w: 21, h: 20 } },
  { id: "tent-2", name: "Tent", from: { x: 92, y: 220, w: 20, h: 20 } },
];
const TENT_CELLS = 3;

/**
 * The bedroll in whole pixels, along it from the head (0) to the foot and
 * across it, and `z` up. The canvas mat lies flat and the blanket over it is
 * turned back short of the head, which leaves the mat bare there.
 */
type Part = "mat" | "blanket" | "fold";
const BEDROLL_PARTS: {
  part: Part;
  along: [number, number];
  across: [number, number];
  z: [number, number];
}[] = [
  { part: "mat", along: [1, 15], across: [1, 7], z: [0, 1] },
  { part: "blanket", along: [7, 15], across: [1, 7], z: [1, 2] },
  { part: "fold", along: [5, 7], across: [1, 7], z: [1, 2] },
];
const BEDROLL_TOP = 2;

/** Palette indices by face, lit from the south-west as every block is: top, south, east. */
const BEDROLL_SHADES: Record<Part, Record<Face, number>> = {
  mat: { top: 22, south: 8, east: 4 },
  blanket: { top: 9, south: 10, east: 3 },
  fold: { top: 10, south: 10, east: 9 },
};
const BEDROLL_EDGE = 0;

type Face = "top" | "south" | "east";

/**
 * Where a pixel along and across the bedroll lies in the anchor cell's own
 * pixels for each facing. The anchor is the south-east cell, so the second
 * cell is at -8 on x facing east or west and on y facing north or south.
 * Facing is where the feet point, as the bed's is.
 */
const LAY: Record<Direction, (along: number, across: number) => [number, number]> = {
  e: (along, across) => [along - CELL_SIZE, across],
  w: (along, across) => [CELL_SIZE - 1 - along, across],
  s: (along, across) => [across, along - CELL_SIZE],
  n: (along, across) => [across, CELL_SIZE - 1 - along],
};

const BEDROLL_SPRITE_CELLS = 3;
const BEDROLL_PX = BEDROLL_SPRITE_CELLS * CELL_SIZE;
const BEDROLL_PROJECTION = {
  spritePx: BEDROLL_PX,
  groundPx: BEDROLL_PX - CELL_SIZE,
  topPx: BEDROLL_TOP,
};

function bedrollVoxels(facing: Direction): Map<string, Part> {
  const voxels = new Map<string, Part>();
  for (const { part, along, across, z } of BEDROLL_PARTS) {
    for (let a = along[0]; a < along[1]; a++) {
      for (let c = across[0]; c < across[1]; c++) {
        const [x, y] = LAY[facing](a, c);
        for (let h = z[0]; h < z[1]; h++) voxels.set(`${x},${y},${h}`, part);
      }
    }
  }
  return voxels;
}

/**
 * A ray walks down towards `-x`, `-y` and `-z` at once, so the face it came
 * in through is the axis whose fraction is nearest 1.
 */
function bedrollModel(facing: Direction): Model<{ part: Part; face: Face }> {
  const voxels = bedrollVoxels(facing);
  return {
    sample: (p, scale) => {
      const q = p.map((c) => c / scale);
      const [x, y, z] = q.map(Math.floor) as [number, number, number];
      const part = voxels.get(`${x},${y},${z}`);
      if (!part) return null;
      const fx = q[0]! - x;
      const fy = q[1]! - y;
      const fz = q[2]! - z;
      return { part, face: fz >= fx && fz >= fy ? "top" : fy >= fx ? "south" : "east" };
    },
    shade: ({ part, face }) => BEDROLL_SHADES[part][face],
  };
}

function outline(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const at = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size && pixels[v * size + u]! >= 0;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (!at(u, v) && (at(u - 1, v) || at(u + 1, v) || at(u, v - 1) || at(u, v + 1)))
        out[v * size + u] = BEDROLL_EDGE;
    }
  }
  return out;
}

/**
 * Lying east or west the bedroll is two cells long and one deep, so its
 * sprite is the cast's lower two rows; lying north or south it is the cast's
 * right two columns. Each is placed on the sheet below the tents.
 */
const BEDROLL_FACINGS: {
  facing: Direction;
  at: { x: number; y: number };
  crop: { x: number; y: number; w: number; h: number };
}[] = [
  { facing: "e", at: { x: 0, y: 0 }, crop: { x: 0, y: 1, w: 3, h: 2 } },
  { facing: "w", at: { x: 3, y: 0 }, crop: { x: 0, y: 1, w: 3, h: 2 } },
  { facing: "s", at: { x: 0, y: 2 }, crop: { x: 1, y: 0, w: 2, h: 3 } },
  { facing: "n", at: { x: 2, y: 2 }, crop: { x: 1, y: 0, w: 2, h: 3 } },
];
const BEDROLL_CELL = { x: 0, y: TENT_CELLS };
const BEDROLL_ROWS = 5;

/**
 * A hide stretched in an upright frame facing south, one cell wide and about
 * half a person tall. It is cast in the south-east cell of a two-cell square, so
 * the frame has the cells above and to the left of it to lean into.
 */
const RACK_CELLS = 2;
const RACK_CELL = { x: 4, y: TENT_CELLS + 2 };
const RACK_PX = RACK_CELLS * 8;
const RACK_PROJECTION = { spritePx: RACK_PX, groundPx: 8, topPx: RACK_PX - 1 };
const RACK_Y = 4;
const POST_X = [1.2, 7.2];
const POST_TOP = 7.5;
const BARS_Z = [2.5, 6.8];
const HIDE = { x: [2, 6.4], z: [3.1, 6.2] };

type RackPart = "wood" | "hide" | "rim" | "lashing";
type RackHit = { part: RackPart; normal: Vec3 };

/** Palette indices: wood lit, wood in shade, hide, hide rim, rawhide cord. */
const RACK_INK = { woodLit: 11, woodShade: 3, woodTop: 13, hide: 19, hideRim: 18, lashing: 2 };
/** The furniture's two edge colours: near-black below and right, dark red above and left. */
const EDGE_SHADOW = 0;
const EDGE_LIT = 3;

function beam(p: Vec3, from: Vec3, to: Vec3): Vec3 | null {
  for (let i = 0; i < 3; i++) {
    if (p[i]! < from[i]! || p[i]! > to[i]!) return null;
  }
  const dx = Math.min(p[0] - from[0], to[0] - p[0]);
  const dy = Math.min(p[1] - from[1], to[1] - p[1]);
  const dz = to[2] - p[2];
  if (dz <= dx && dz <= dy) return [0, 0, 1];
  return dx < dy ? [p[0] - from[0] < to[0] - p[0] ? -1 : 1, 0, 0] : [0, 1, 0];
}

/**
 * The hide is an oval pulled out towards the four lashings at its corners, the
 * shape a skin takes when its legs are tied to the frame.
 */
function inHide(x: number, z: number): "hide" | "rim" | null {
  const cx = (HIDE.x[0] + HIDE.x[1]) / 2;
  const cz = (HIDE.z[0] + HIDE.z[1]) / 2;
  const u = Math.abs(x - cx) / ((HIDE.x[1] - HIDE.x[0]) / 2);
  const w = Math.abs(z - cz) / ((HIDE.z[1] - HIDE.z[0]) / 2);
  const reach = u ** 2 + w ** 2 - 0.55 * u * w;
  if (reach > 1) return null;
  return reach > 0.72 ? "rim" : "hide";
}

function sampleRack(p: Vec3, scale: number): RackHit | null {
  const q: Vec3 = [p[0] / scale, p[1] / scale, p[2] / scale];
  const half = 0.6;
  for (const x of POST_X) {
    const normal = beam(q, [x - half, RACK_Y - half, 0], [x + half, RACK_Y + half, POST_TOP]);
    if (normal) return { part: "wood", normal };
  }
  for (const z of BARS_Z) {
    const normal = beam(
      q,
      [POST_X[0]!, RACK_Y - 0.45, z - 0.45],
      [POST_X[1]!, RACK_Y + 0.45, z + 0.45],
    );
    if (normal) return { part: "wood", normal };
  }
  if (Math.abs(q[1] - RACK_Y) > 0.4) return null;
  const hide = inHide(q[0], q[2]);
  if (hide) return { part: hide, normal: [0, 1, 0] };
  for (const [hx, hz, fx, fz] of [
    [HIDE.x[0] + 0.6, HIDE.z[0] + 0.3, POST_X[0]! + 0.7, BARS_Z[0]! + 0.5],
    [HIDE.x[1] - 0.6, HIDE.z[0] + 0.3, POST_X[1]! - 0.7, BARS_Z[0]! + 0.5],
    [HIDE.x[0] + 0.6, HIDE.z[1] - 0.3, POST_X[0]! + 0.7, BARS_Z[1]! - 0.5],
    [HIDE.x[1] - 0.6, HIDE.z[1] - 0.3, POST_X[1]! - 0.7, BARS_Z[1]! - 0.5],
  ] as const) {
    const t = Math.max(
      0,
      Math.min(
        1,
        ((q[0] - hx) * (fx - hx) + (q[2] - hz) * (fz - hz)) / ((fx - hx) ** 2 + (fz - hz) ** 2),
      ),
    );
    const d = Math.hypot(q[0] - (hx + t * (fx - hx)), q[2] - (hz + t * (fz - hz)));
    if (d < 0.35) return { part: "lashing", normal: [0, 1, 0] };
  }
  return null;
}

function shadeRack(hit: RackHit): number {
  if (hit.part === "hide") return RACK_INK.hide;
  if (hit.part === "rim") return RACK_INK.hideRim;
  if (hit.part === "lashing") return RACK_INK.lashing;
  if (hit.normal[2] === 1) return RACK_INK.woodTop;
  return hit.normal[0] === 1 ? RACK_INK.woodShade : RACK_INK.woodLit;
}

const RACK_MODEL = { sample: sampleRack, shade: shadeRack };

function edge(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const at = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size && pixels[v * size + u]! >= 0;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (at(u, v)) continue;
      if (at(u - 1, v) || at(u, v - 1)) out[v * size + u] = EDGE_SHADOW;
      else if (at(u + 1, v) || at(u, v + 1)) out[v * size + u] = EDGE_LIT;
    }
  }
  return out;
}

function still(
  rect: { x: number; y: number; w: number; h: number },
  base: { x: number; y: number },
) {
  return { frames: [{ sprite: { rect, base }, durationMs: 200 }] };
}

function tiles(): TileDef[] {
  const tents = TENTS.map(
    ({ id, name }, i) =>
      ({
        id,
        name,
        height: 3,
        type: "simple",
        kind: "prop",
        attributes: {},
        anchor: { tilesetId: TILESET_ID, x: i * TENT_CELLS, y: 0 },
        lightPassing: true,
        walkable: false,
        footprint: { w: 2, d: 2 },
        sprite: still({ x: 0, y: 0, w: TENT_CELLS, h: TENT_CELLS }, { x: 2, y: 2 }),
      }) as TileDef,
  );
  const bedroll = {
    id: "bedroll",
    name: "Bedroll",
    height: 0,
    type: "directional",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, ...BEDROLL_CELL },
    lightPassing: true,
    footprint: { w: 1, d: 2 },
    sprites: Object.fromEntries(
      BEDROLL_FACINGS.map(({ facing, at, crop }) => [
        facing,
        still({ ...at, w: crop.w, h: crop.h }, { x: crop.w - 1, y: crop.h - 1 }),
      ]),
    ),
  } as TileDef;
  const rack = {
    id: "tanning-rack",
    name: "Tanning Rack",
    height: 2,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, ...RACK_CELL },
    lightPassing: true,
    walkable: false,
    sprite: still(
      { x: 0, y: 0, w: RACK_CELLS, h: RACK_CELLS },
      { x: RACK_CELLS - 1, y: RACK_CELLS - 1 },
    ),
  } as TileDef;
  return [...tents, bedroll, rack];
}

async function main() {
  const source = PNG.sync.read(await fs.readFile(SOURCE));
  const cell = 8;
  const sheet = new PNG({
    width: TENTS.length * TENT_CELLS * cell,
    height: (TENT_CELLS + BEDROLL_ROWS) * cell,
  });
  sheet.data.fill(0);
  for (const [i, { from }] of TENTS.entries()) {
    const left = (i + 1) * TENT_CELLS * cell - from.w;
    const top = TENT_CELLS * cell - from.h;
    for (let y = 0; y < from.h; y++) {
      for (let x = 0; x < from.w; x++) {
        const at = ((from.y + y) * source.width + from.x + x) * 4;
        const rgba = [...source.data.subarray(at, at + 4)] as Rgba;
        if (rgba[3] > 0) paintRgba(sheet, left + x, top + y, rgba);
      }
    }
  }
  for (const { facing, at, crop } of BEDROLL_FACINGS) {
    const model = bedrollModel(facing);
    const pixels = outline(castModel(model, BEDROLL_PROJECTION), BEDROLL_PX);
    for (let v = 0; v < crop.h * cell; v++) {
      for (let u = 0; u < crop.w * cell; u++) {
        const index = pixels[(crop.y * cell + v) * BEDROLL_PX + crop.x * cell + u]!;
        const x = (BEDROLL_CELL.x + at.x) * cell + u;
        const y = (BEDROLL_CELL.y + at.y) * cell + v;
        if (index >= 0) paint(sheet, x, y, index);
      }
    }
    /** `PREVIEW=<dir>` also writes each facing cast four times larger, to judge its shape. */
    if (process.env.PREVIEW) {
      const file = path.join(process.env.PREVIEW, `bedroll-${facing}-4x.png`);
      await writeCast(file, castModel(model, BEDROLL_PROJECTION, 4), BEDROLL_PX * 4);
    }
  }
  const rack = edge(castModel(RACK_MODEL, RACK_PROJECTION), RACK_PX);
  for (let i = 0; i < rack.length; i++) {
    if (rack[i]! < 0) continue;
    paint(
      sheet,
      RACK_CELL.x * cell + (i % RACK_PX),
      RACK_CELL.y * cell + Math.floor(i / RACK_PX),
      rack[i]!,
    );
  }
  if (process.env.PREVIEW) {
    const scale = 6;
    await writeCast(
      path.join(process.env.PREVIEW, "tanning-rack.png"),
      castModel(RACK_MODEL, RACK_PROJECTION, scale),
      RACK_PX * scale,
    );
  }
  await writeTileset(TILESET_ID, "Camp", sheet, tiles());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
