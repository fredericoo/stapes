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
const TILE_ID = "cave-wall";

const CELL = CELL_SIZE;
const HALF = CELL / 2;
const RIDGE = CELL / 4;
const RISE = HEIGHT_PER_LEVEL * PX_PER_HEIGHT;

const SPRITE_CELLS = 2;
const SLICES_PER_ROW = 8;
const FRAME_MS = 200;

type Ink = { base: number; fleck: number; fleckPercent: number; salt: number };

/**
 * Palette indices of `half-stone`'s three faces, so the two can share a cave,
 * plus the entry between its south and east tones for a wall turning between them.
 */
const TOP: Ink = { base: 3, fleck: 11, fleckPercent: 12, salt: 1 };
const SOUTH: Ink = { base: 18, fleck: 11, fleckPercent: 16, salt: 2 };
const BEVEL: Ink = { base: 13, fleck: 11, fleckPercent: 14, salt: 4 };
const EAST: Ink = { base: 11, fleck: 3, fleckPercent: 12, salt: 3 };

const NORMAL_REACH = 2;

type Point = { x: number; y: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * A quarter of the cell is rock only when all three neighbours around its
 * corner are, so every face of a solid mass sits on a cell's half line and a
 * passage one cell wide is drawn two wide. Indexed so that `i ^ 1` and `i ^ 2`
 * are the quarters beside quarter `i`, and `i ^ 3` the one across from it.
 */
const QUADRANTS: { needs: number; corner: Point }[] = [
  { needs: N | NW | W, corner: { x: 0, y: 0 } },
  { needs: N | NE | E, corner: { x: CELL, y: 0 } },
  { needs: S | SW | W, corner: { x: 0, y: CELL } },
  { needs: S | SE | E, corner: { x: CELL, y: CELL } },
];

/**
 * Rock with open ground on both sides would get no quarter at all, so it is
 * drawn as a ridge half a cell thick toward each rock neighbour. A ridge beside
 * a filled quarter is left out, or it would stick past that quarter's face.
 */
const RIDGES: { side: number; beside: readonly [number, number]; rect: Rect }[] = [
  { side: N, beside: [0, 1], rect: { x0: HALF - RIDGE, y0: 0, x1: HALF + RIDGE, y1: HALF } },
  { side: E, beside: [1, 3], rect: { x0: HALF, y0: HALF - RIDGE, x1: CELL, y1: HALF + RIDGE } },
  { side: S, beside: [2, 3], rect: { x0: HALF - RIDGE, y0: HALF, x1: HALF + RIDGE, y1: CELL } },
  { side: W, beside: [0, 2], rect: { x0: 0, y0: HALF - RIDGE, x1: HALF, y1: HALF + RIDGE } },
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

/**
 * A corner of solid rock at the cell's centre becomes an arc centred on the cell
 * corner, half a cell across, which is the widest that meets both neighbouring
 * slices square on their half lines. Filled quarters on opposite corners stay
 * whole, so a rock cell between two diagonal pockets does not read as open.
 */
function quadrantRock(filled: boolean[], x: number, y: number): boolean {
  const i = (x < HALF ? 0 : 1) | (y < HALF ? 0 : 2);
  const { corner } = QUADRANTS[i]!;
  const fromCorner = Math.hypot(x - corner.x, y - corner.y);
  if (filled[i]) return filled[i ^ 1] || filled[i ^ 2] || filled[i ^ 3] || fromCorner < HALF;
  return filled[i ^ 1] && filled[i ^ 2] && fromCorner >= HALF;
}

/** The corner a fillet rounds is a ridge's half-width from its centre, toward the cell's middle. */
function inFillet(centre: Point, x: number, y: number): boolean {
  const kx = centre.x + Math.sign(HALF - centre.x) * RIDGE;
  const ky = centre.y + Math.sign(HALF - centre.y) * RIDGE;
  const inCorner =
    x >= Math.min(centre.x, kx) &&
    x < Math.max(centre.x, kx) &&
    y >= Math.min(centre.y, ky) &&
    y < Math.max(centre.y, ky);
  return inCorner && Math.hypot(x - centre.x, y - centre.y) >= RIDGE;
}

function footprint(mask: number): boolean[][] {
  const filled = QUADRANTS.map(({ needs }) => (mask & needs) === needs);
  const ridges = RIDGES.filter(
    ({ side, beside }) => (mask & side) !== 0 && !filled[beside[0]] && !filled[beside[1]],
  );
  const ridgeSides = ridges.reduce((sides, { side }) => sides | side, 0);
  /** Ridges meet in a disc at the centre, which is all there is of a cell with no rock beside it. */
  const hub = ridges.length > 0 || !filled.some(Boolean);
  const fillets = FILLETS.filter(
    (f) => (ridgeSides & f.ridges) === f.ridges && (f.quadrant === undefined || filled[f.quadrant]),
  );
  return Array.from({ length: CELL }, (_, row) =>
    Array.from({ length: CELL }, (_, col) => {
      const x = col + 0.5;
      const y = row + 0.5;
      return (
        quadrantRock(filled, x, y) ||
        ridges.some(({ rect }) => x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) ||
        (hub && Math.hypot(x - HALF, y - HALF) < RIDGE) ||
        fillets.some(({ centre }) => inFillet(centre, x, y))
      );
    }),
  );
}

/**
 * Walks the view ray through sprite pixel `sx, sy` down from the top of the wall,
 * which is footprint pixel `sx, sy`: the wall rises the one cell the sprite's base
 * is offset by. The ray crosses the grid only at pixel corners, so it is nudged
 * east of each, and a hit on the pixel beside the diagonal is a south face.
 */
function hitAt(solid: boolean[][], sx: number, sy: number): (Point & { face: Ink }) | null {
  const rock = (x: number, y: number) => x >= 0 && y >= 0 && x < CELL && y < CELL && solid[y]![x]!;
  if (rock(sx, sy)) return { x: sx, y: sy, face: TOP };
  for (let k = 1; k <= RISE; k++) {
    if (rock(sx - k + 1, sy - k)) return { x: sx - k + 1, y: sy - k, face: SOUTH };
    if (rock(sx - k, sy - k)) return { x: sx - k, y: sy - k, face: EAST };
  }
  return null;
}

/**
 * Shades a side by the way the outline faces around the footprint pixel it was
 * hit on, rather than by the single step the ray met, which alternates along a
 * curve and draws a checkerboard. Past the cell's edge the edge pixel is read
 * again, since every outline crosses the edge square on.
 */
function sideInk(solid: boolean[][], x: number, y: number, step: Ink): Ink {
  let nx = 0;
  let ny = 0;
  for (let dy = -NORMAL_REACH; dy <= NORMAL_REACH; dy++) {
    for (let dx = -NORMAL_REACH; dx <= NORMAL_REACH; dx++) {
      const col = Math.min(CELL - 1, Math.max(0, x + dx));
      const row = Math.min(CELL - 1, Math.max(0, y + dy));
      if (!solid[row]![col]!) {
        nx += dx;
        ny += dy;
      }
    }
  }
  if (nx === 0 && ny === 0) return step;
  const angle = Math.atan2(ny, nx);
  if (angle > (3 * Math.PI) / 8) return SOUTH;
  if (angle < Math.PI / 8) return EAST;
  return BEVEL;
}

/**
 * Keyed on the screen pixel modulo a cell, so every slice agrees on where the
 * flecks fall and a face that runs across several cells has no seam.
 */
function flecked(sx: number, sy: number, ink: Ink): boolean {
  let h =
    Math.imul((sx % CELL) + 1, 0x27d4eb2d) ^
    Math.imul((sy % CELL) + 1, 0x165667b1) ^
    Math.imul(ink.salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) % 100 < ink.fleckPercent;
}

function rgba(index: number): [number, number, number, number] {
  const hex = STAPES_PALETTE[index];
  if (!hex) throw new Error(`no palette entry ${index}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

function drawSlice(sheet: PNG, originX: number, originY: number, mask: number) {
  const solid = footprint(mask);
  const size = SPRITE_CELLS * CELL;
  for (let sy = 0; sy < size; sy++) {
    for (let sx = 0; sx < size; sx++) {
      const hit = hitAt(solid, sx, sy);
      if (!hit) continue;
      const ink = hit.face === TOP ? TOP : sideInk(solid, hit.x, hit.y, hit.face);
      const colour = rgba(flecked(sx, sy, ink) ? ink.fleck : ink.base);
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
  const rows = Math.ceil(AUTOTILE_SLICE_COUNT / SLICES_PER_ROW);
  const sheet = new PNG({
    width: SLICES_PER_ROW * SPRITE_CELLS * CELL,
    height: rows * SPRITE_CELLS * CELL,
  });
  sheet.data.fill(0);

  const slices: Record<number, TileSprite> = {};
  for (let slice = 0; slice < AUTOTILE_SLICE_COUNT; slice++) {
    const rect = sliceRect(slice);
    drawSlice(sheet, rect.x * CELL, rect.y * CELL, AUTOTILE_SLICE_MASKS[slice]!);
    slices[slice] = {
      frames: [{ sprite: { rect, base: { x: 1, y: 1 } }, durationMs: FRAME_MS }],
    };
  }
  await fs.writeFile(path.join(DATA, "tilesets", `${TILESET_ID}.png`), PNG.sync.write(sheet));

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = await readJson<TileDef[]>(tilesPath);
  const anchor = { tilesetId: TILESET_ID, x: 0, y: 0 };
  const existing = tiles.find((t) => t.id === TILE_ID);
  if (existing) {
    delete existing.sprite;
    Object.assign(existing, { type: "autotile", anchor, slices } satisfies Partial<TileDef>);
  } else {
    tiles.push({
      id: TILE_ID,
      name: "Cave Wall",
      height: 4,
      type: "autotile",
      kind: "prop",
      attributes: {},
      anchor,
      walkable: false,
      connectsTo: ["stone-wall", "half-stone"],
      slices,
    });
  }
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
      `${AUTOTILE_SLICE_COUNT} slices`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
