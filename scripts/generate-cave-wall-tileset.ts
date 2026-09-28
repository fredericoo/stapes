import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import { STAPES_PALETTE } from "../app/lib/palette";
import {
  AUTOTILE_SLICE_COUNT,
  CELL_SIZE,
  HEIGHT_PER_LEVEL,
  type TileDef,
  type TileSprite,
  type TilesetDef,
} from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");

const TILESET_ID = "cave-wall";

const CELL = CELL_SIZE;
const HALF = CELL / 2;
const RIDGE = CELL / 4;
const RISE = HEIGHT_PER_LEVEL * PX_PER_HEIGHT;

const SPRITE_CELLS = 2;
const SLICES_PER_ROW = 8;
const VARIANT_ROWS = Math.ceil(AUTOTILE_SLICE_COUNT / SLICES_PER_ROW) * SPRITE_CELLS;
const FRAME_MS = 200;

type Face = "top" | "south" | "bevel" | "east";

/** A speck `width` pixels wide covers `percent` of the positions it can start at. */
type Speck = { index: number; percent: number; width?: number };
type Ink = { base: number; specks: Speck[]; salt: number };
type Rock = Record<Face, Ink>;

/**
 * Palette indices of `half-stone`'s three faces, so the two can share a cave,
 * plus the entry between its south and east tones for a wall turning between them.
 */
const RED: Rock = {
  top: { base: 3, specks: [{ index: 11, percent: 12 }], salt: 1 },
  south: { base: 18, specks: [{ index: 11, percent: 16 }], salt: 2 },
  bevel: { base: 13, specks: [{ index: 11, percent: 14 }], salt: 4 },
  east: { base: 11, specks: [{ index: 3, percent: 12 }], salt: 3 },
};

/**
 * The palette's neutral dark grey on top and `stone-wall`'s greys on the sides,
 * each about as light as the red rock's same face, marked with streaks two
 * pixels wide a shade darker and single glints a shade lighter.
 */
const GREY: Rock = {
  top: {
    base: 1,
    specks: [
      { index: 8, percent: 7 },
      { index: 0, percent: 5 },
    ],
    salt: 5,
  },
  south: {
    base: 25,
    specks: [
      { index: 22, percent: 10, width: 2 },
      { index: 27, percent: 5 },
    ],
    salt: 6,
  },
  bevel: {
    base: 22,
    specks: [
      { index: 8, percent: 8, width: 2 },
      { index: 25, percent: 4 },
    ],
    salt: 7,
  },
  east: {
    base: 8,
    specks: [
      { index: 4, percent: 5, width: 2 },
      { index: 4, percent: 6 },
      { index: 22, percent: 3 },
    ],
    salt: 8,
  },
};

/**
 * Every variant shares one sheet, so a cave that mixes them costs no more draw
 * calls than a cave of one, and each connects to the others so the rock stays
 * whole where they meet. All have the same outline at the ceiling; `spread` is
 * how much wider the rock is at the floor.
 */
const VARIANTS: { tileId: string; name: string; spread: number; rock: Rock }[] = [
  { tileId: "cave-wall", name: "Cave Wall", spread: 0, rock: RED },
  { tileId: "cave-wall-sloped", name: "Sloped Cave Wall", spread: HALF, rock: RED },
  { tileId: "cave-wall-grey", name: "Grey Cave Wall", spread: 0, rock: GREY },
  { tileId: "cave-wall-sloped-grey", name: "Grey Sloped Cave Wall", spread: HALF, rock: GREY },
];

const NORMAL_REACH = 2;

type Point = { x: number; y: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * A quarter of the cell is rock only when all three neighbours around its
 * corner are, so every face of a solid mass sits on a cell's half line and a
 * passage one cell wide is drawn two wide. Indexed so that `i ^ 1` and `i ^ 2`
 * are the quarters beside quarter `i`, and `i ^ 3` the one across from it.
 */
const QUADRANTS: { needs: number; corner: Point; square: Rect }[] = [
  { needs: N | NW | W, corner: { x: 0, y: 0 }, square: { x0: 0, y0: 0, x1: HALF, y1: HALF } },
  { needs: N | NE | E, corner: { x: CELL, y: 0 }, square: { x0: HALF, y0: 0, x1: CELL, y1: HALF } },
  { needs: S | SW | W, corner: { x: 0, y: CELL }, square: { x0: 0, y0: HALF, x1: HALF, y1: CELL } },
  {
    needs: S | SE | E,
    corner: { x: CELL, y: CELL },
    square: { x0: HALF, y0: HALF, x1: CELL, y1: CELL },
  },
];

/**
 * Rock with open ground on both sides would get no quarter at all, so it is
 * drawn as a ridge half a cell thick toward each rock neighbour. A ridge beside
 * a filled quarter is left out, or it would stick past that quarter's face.
 * `flanks` are the edges a ridge runs alongside, each with the quarter at its
 * far end.
 */
const RIDGES: {
  side: number;
  beside: readonly [number, number];
  rect: Rect;
  flanks: readonly { edge: number; quadrant: number }[];
}[] = [
  {
    side: N,
    beside: [0, 1],
    rect: { x0: HALF - RIDGE, y0: 0, x1: HALF + RIDGE, y1: HALF },
    flanks: [
      { edge: W, quadrant: 2 },
      { edge: E, quadrant: 3 },
    ],
  },
  {
    side: E,
    beside: [1, 3],
    rect: { x0: HALF, y0: HALF - RIDGE, x1: CELL, y1: HALF + RIDGE },
    flanks: [
      { edge: N, quadrant: 0 },
      { edge: S, quadrant: 2 },
    ],
  },
  {
    side: S,
    beside: [2, 3],
    rect: { x0: HALF - RIDGE, y0: HALF, x1: HALF + RIDGE, y1: CELL },
    flanks: [
      { edge: W, quadrant: 0 },
      { edge: E, quadrant: 1 },
    ],
  },
  {
    side: W,
    beside: [0, 2],
    rect: { x0: 0, y0: HALF - RIDGE, x1: HALF, y1: HALF + RIDGE },
    flanks: [
      { edge: N, quadrant: 1 },
      { edge: S, quadrant: 3 },
    ],
  },
];

/**
 * The inside corners where a ridge meets another ridge, or the face of a filled
 * quarter, each rounded by a circle centred here. Every one stays two pixels in
 * from the cell's edge, where the outline has to meet the neighbouring slice.
 */
const FILLETS: { ridges: number; quadrant?: number; centre: Point }[] = [
  { ridges: N | W, centre: { x: 0, y: 0 } },
  { ridges: N | E, centre: { x: CELL, y: 0 } },
  { ridges: S | W, centre: { x: 0, y: CELL } },
  { ridges: S | E, centre: { x: CELL, y: CELL } },
  { ridges: N, quadrant: 2, centre: { x: 0, y: HALF - RIDGE } },
  { ridges: N, quadrant: 3, centre: { x: CELL, y: HALF - RIDGE } },
  { ridges: S, quadrant: 0, centre: { x: 0, y: HALF + RIDGE } },
  { ridges: S, quadrant: 1, centre: { x: CELL, y: HALF + RIDGE } },
  { ridges: E, quadrant: 0, centre: { x: HALF + RIDGE, y: 0 } },
  { ridges: E, quadrant: 2, centre: { x: HALF + RIDGE, y: CELL } },
  { ridges: W, quadrant: 1, centre: { x: HALF - RIDGE, y: 0 } },
  { ridges: W, quadrant: 3, centre: { x: HALF - RIDGE, y: CELL } },
];

function inRect({ x0, y0, x1, y1 }: Rect, x: number, y: number): boolean {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

function distanceToRect({ x0, y0, x1, y1 }: Rect, x: number, y: number): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
}

/**
 * A corner of solid rock at the cell's centre becomes an arc centred on the cell
 * corner, half a cell across, which is the widest that meets both neighbouring
 * slices square on their half lines. Filled quarters on opposite corners stay
 * whole, so a rock cell between two diagonal pockets does not read as open.
 * Widening by `grow` pushes each face out, grows each arc and shrinks each
 * pocket, all about the same cell corners, so every edge still depends only on
 * the two quarters the neighbouring slice shares.
 */
function quadrantRock(filled: boolean[], x: number, y: number, grow: number): boolean {
  return QUADRANTS.some(({ corner, square }, i) => {
    const fromCorner = Math.hypot(x - corner.x, y - corner.y);
    if (!filled[i]) {
      return filled[i ^ 1]! && filled[i ^ 2]! && inRect(square, x, y) && fromCorner >= HALF - grow;
    }
    if (filled[i ^ 1] || filled[i ^ 2] || filled[i ^ 3]) {
      return inRect(square, x, y) || distanceToRect(square, x, y) < grow;
    }
    return fromCorner < HALF + grow;
  });
}

/** The corner a fillet rounds is its radius from its centre, toward the cell's middle. */
function inFillet(centre: Point, radius: number, x: number, y: number): boolean {
  const corner = {
    x0: centre.x,
    y0: centre.y,
    x1: centre.x + Math.sign(HALF - centre.x) * radius,
    y1: centre.y + Math.sign(HALF - centre.y) * radius,
  };
  const inCorner =
    x >= Math.min(corner.x0, corner.x1) &&
    x < Math.max(corner.x0, corner.x1) &&
    y >= Math.min(corner.y0, corner.y1) &&
    y < Math.max(corner.y0, corner.y1);
  return inCorner && Math.hypot(x - centre.x, y - centre.y) >= radius;
}

/**
 * A ridge widened by `grow` on both sides. Where it runs beside an edge whose
 * neighbour shows only the face of the quarter at that edge's far end, it stops
 * a pixel short of the edge: that neighbour cannot see the ridge, so rock there
 * would meet nothing on the other side.
 */
function ridgeRect(ridge: (typeof RIDGES)[number], mask: number, filled: boolean[], grow: number) {
  const along = ridge.side === N || ridge.side === S;
  const rect = along
    ? { ...ridge.rect, x0: ridge.rect.x0 - grow, x1: ridge.rect.x1 + grow }
    : { ...ridge.rect, y0: ridge.rect.y0 - grow, y1: ridge.rect.y1 + grow };
  for (const { edge, quadrant } of ridge.flanks) {
    if ((mask & edge) === 0 || !filled[quadrant]) continue;
    if (edge === W) rect.x0 = Math.max(rect.x0, 1);
    if (edge === E) rect.x1 = Math.min(rect.x1, CELL - 1);
    if (edge === N) rect.y0 = Math.max(rect.y0, 1);
    if (edge === S) rect.y1 = Math.min(rect.y1, CELL - 1);
  }
  return rect;
}

function outline(mask: number, grow = 0): (x: number, y: number) => boolean {
  const filled = QUADRANTS.map(({ needs }) => (mask & needs) === needs);
  const ridges = RIDGES.filter(
    ({ side, beside }) => (mask & side) !== 0 && !filled[beside[0]] && !filled[beside[1]],
  );
  /**
   * A ridge, and the disc at the centre where ridges meet, stand half as far
   * from the cell's edge as a face does, so they widen at half the rate and every
   * slope reaches the edge at the floor. The disc is all there is of a cell with
   * no rock beside it.
   */
  const thicken = grow / 2;
  const rects = ridges.map((ridge) => ridgeRect(ridge, mask, filled, thicken));
  const ridgeSides = ridges.reduce((sides, { side }) => sides | side, 0);
  const hub = ridges.length > 0 || !filled.some(Boolean);
  const filletRadius = RIDGE - thicken;
  const fillets = FILLETS.filter(
    (f) =>
      filletRadius > 0 &&
      (ridgeSides & f.ridges) === f.ridges &&
      (f.quadrant === undefined || filled[f.quadrant]),
  );
  return (x, y) =>
    quadrantRock(filled, x, y, grow) ||
    rects.some((rect) => inRect(rect, x, y)) ||
    (hub && Math.hypot(x - HALF, y - HALF) < RIDGE + thicken) ||
    fillets.some(({ centre }) => inFillet(centre, filletRadius, x, y));
}

/**
 * Around a cell corner whose four cells are not all rock, two of the slices
 * that meet there may not see each other, and each would widen toward the
 * corner from a different ridge or face. Keeping the pixel at that corner empty
 * until the floor, where every slope reaches it, is the one answer both give.
 */
function footprint(mask: number, grow = 0): boolean[][] {
  const rock = outline(mask, grow);
  const grid = Array.from({ length: CELL }, (_, row) =>
    Array.from({ length: CELL }, (_, col) => rock(col + 0.5, row + 0.5)),
  );
  if (grow < HALF) {
    QUADRANTS.forEach(({ needs, corner }) => {
      if ((mask & needs) !== needs) {
        grid[Math.min(corner.y, CELL - 1)]![Math.min(corner.x, CELL - 1)] = false;
      }
    });
  }
  return grid;
}

/**
 * The rock in each pixel of height, floor first: the outline at the ceiling,
 * widened toward the floor by a share of `spread` that grows in a straight line,
 * so the sides slope out evenly.
 */
function crossSections(mask: number, spread: number): boolean[][][] {
  return Array.from({ length: RISE }, (_, layer) =>
    footprint(mask, (spread * (RISE - 1 - layer)) / (RISE - 1)),
  );
}

/**
 * Walks the view ray through sprite pixel `sx, sy` down from the top of the wall,
 * which is footprint pixel `sx, sy`: the wall rises the one cell the sprite's base
 * is offset by. The ray crosses the grid only at pixel corners, so it is nudged
 * east of each, and a hit on the pixel beside the diagonal is a south face. Below
 * the top, a pixel met from above is the tread of a slope.
 */
function hitAt(
  layers: boolean[][][],
  sx: number,
  sy: number,
): (Point & { layer: number; face: Face }) | null {
  const rock = (layer: number, x: number, y: number) =>
    x >= 0 && y >= 0 && x < CELL && y < CELL && layers[layer]![y]![x]!;
  for (let layer = RISE - 1; layer >= 0; layer--) {
    const x = sx - (RISE - 1 - layer);
    const y = sy - (RISE - 1 - layer);
    if (rock(layer, x, y)) return { x, y, layer, face: layer === RISE - 1 ? "top" : "south" };
    if (rock(layer, x, y - 1)) return { x, y: y - 1, layer, face: "south" };
    if (rock(layer, x - 1, y - 1)) return { x: x - 1, y: y - 1, layer, face: "east" };
  }
  return null;
}

/**
 * Shades a side by the way the rock falls away around the footprint pixel it was
 * hit on, rather than by the single step the ray met, which alternates along a
 * curve and draws a checkerboard. It reads the height of the rock rather than one
 * layer's outline, so a slope that has reached the cell's edge still has a
 * direction. Past the edge the edge pixel is read again, since every outline
 * crosses it square on.
 */
function sideFace(heights: number[][], x: number, y: number, step: Face): Face {
  let nx = 0;
  let ny = 0;
  for (let dy = -NORMAL_REACH; dy <= NORMAL_REACH; dy++) {
    for (let dx = -NORMAL_REACH; dx <= NORMAL_REACH; dx++) {
      const col = Math.min(CELL - 1, Math.max(0, x + dx));
      const row = Math.min(CELL - 1, Math.max(0, y + dy));
      nx -= heights[row]![col]! * dx;
      ny -= heights[row]![col]! * dy;
    }
  }
  if (nx === 0 && ny === 0) return step;
  const angle = Math.atan2(ny, nx);
  if (angle > (3 * Math.PI) / 8) return "south";
  if (angle < Math.PI / 8) return "east";
  return "bevel";
}

/**
 * Keyed on the screen pixel modulo a cell, so every slice agrees on where the
 * specks fall and a face that runs across several cells has no seam. A speck
 * two pixels wide hashes the pair it covers, and a cell's width holds whole pairs.
 */
function inkAt(sx: number, sy: number, ink: Ink): number {
  for (const [i, { index, percent, width = 1 }] of ink.specks.entries()) {
    let h =
      Math.imul(Math.floor((sx % CELL) / width) + 1, 0x27d4eb2d) ^
      Math.imul((sy % CELL) + 1, 0x165667b1) ^
      Math.imul(ink.salt + 16 * i, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    if ((h >>> 0) % 100 < percent) return index;
  }
  return ink.base;
}

function rgba(index: number): [number, number, number, number] {
  const hex = STAPES_PALETTE[index];
  if (!hex) throw new Error(`no palette entry ${index}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

function drawSlice(
  sheet: PNG,
  originX: number,
  originY: number,
  mask: number,
  { spread, rock }: { spread: number; rock: Rock },
) {
  const layers = crossSections(mask, spread);
  const heights = layers[0]!.map((row, y) =>
    row.map((_, x) => layers.filter((layer) => layer[y]![x]).length),
  );
  const size = SPRITE_CELLS * CELL;
  for (let sy = 0; sy < size; sy++) {
    for (let sx = 0; sx < size; sx++) {
      const hit = hitAt(layers, sx, sy);
      if (!hit) continue;
      const face = hit.face === "top" ? "top" : sideFace(heights, hit.x, hit.y, hit.face);
      const colour = rgba(inkAt(sx, sy, rock[face]));
      const i = (sheet.width * (originY + sy) + originX + sx) << 2;
      for (let c = 0; c < 4; c++) sheet.data[i + c] = colour[c]!;
    }
  }
}

function sliceRect(slice: number) {
  return {
    x: (slice % SLICES_PER_ROW) * SPRITE_CELLS,
    y: Math.floor(slice / SLICES_PER_ROW) * SPRITE_CELLS,
    w: SPRITE_CELLS,
    h: SPRITE_CELLS,
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const sheet = new PNG({
    width: SLICES_PER_ROW * SPRITE_CELLS * CELL,
    height: VARIANTS.length * VARIANT_ROWS * CELL,
  });
  sheet.data.fill(0);

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = await readJson<TileDef[]>(tilesPath);
  VARIANTS.forEach((variant, v) => {
    const { tileId, name } = variant;
    const anchor = { tilesetId: TILESET_ID, x: 0, y: v * VARIANT_ROWS };
    const slices: Record<number, TileSprite> = {};
    for (let slice = 0; slice < AUTOTILE_SLICE_COUNT; slice++) {
      const rect = sliceRect(slice);
      const mask = AUTOTILE_SLICE_MASKS[slice]!;
      drawSlice(sheet, rect.x * CELL, (anchor.y + rect.y) * CELL, mask, variant);
      slices[slice] = {
        frames: [{ sprite: { rect, base: { x: 1, y: 1 } }, durationMs: FRAME_MS }],
      };
    }
    const others = VARIANTS.filter((other) => other.tileId !== tileId).map((o) => o.tileId);
    const existing = tiles.find((t) => t.id === tileId);
    if (existing) {
      delete existing.sprite;
      const connectsTo = [...new Set([...(existing.connectsTo ?? []), ...others])];
      Object.assign(existing, {
        type: "autotile",
        anchor,
        connectsTo,
        slices,
      } satisfies Partial<TileDef>);
    } else {
      tiles.push({
        id: tileId,
        name,
        height: 4,
        type: "autotile",
        kind: "prop",
        attributes: {},
        anchor,
        walkable: false,
        connectsTo: ["stone-wall", "half-stone", ...others],
        slices,
      });
    }
  });
  await fs.writeFile(path.join(DATA, "tilesets", `${TILESET_ID}.png`), PNG.sync.write(sheet));
  await writeJson(tilesPath, tiles);

  const setsPath = path.join(DATA, "tilesets.json");
  const sets = await readJson<TilesetDef[]>(setsPath);
  const entry: TilesetDef = {
    id: TILESET_ID,
    name: "Cave Wall",
    file: `${TILESET_ID}.png`,
    width: sheet.width,
    height: sheet.height,
  };
  const set = sets.find((s) => s.id === TILESET_ID);
  if (set) Object.assign(set, entry);
  else sets.push(entry);
  await writeJson(setsPath, sets);

  console.log(
    `data/tilesets/${TILESET_ID}.png — ${sheet.width}x${sheet.height}, ` +
      `${VARIANTS.length} variants of ${AUTOTILE_SLICE_COUNT} slices`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
