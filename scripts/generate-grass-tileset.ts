import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import type { TileDef, TileSprite } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const TILESETS = path.join(DATA, "tilesets");

const CELL = 8;

const RAW_MASK_COUNT = 256;

const TEXTURE_FILE = "tiny-ranch-tiles.png";
const TEXTURE_CELL = { x: 0, y: 1 };

const EDGE_SHADE = 0.7;

const TILESET_ID = "grass";
const TILE_ID = "grass-2";

/** Where a straight edge of grass stops, in pixels in from the side it faces. */
const INSET = 2;

/**
 * Added to `INSET` per pixel along each open side. Each side has its own run
 * so a patch's rim does not bite in the same place every cell. A pair of -1s
 * is a tuft of grass reaching out over the dirt.
 */
const RAGGED: Record<"n" | "e" | "s" | "w", readonly number[]> = {
  n: [0, 1, 0, -1, -1, 0, 1, 0],
  e: [0, 0, 1, 0, -1, -1, 0, 1],
  s: [1, 0, -1, -1, 0, 0, 1, 0],
  w: [0, -1, -1, 0, 1, 0, 0, 0],
};

const OUTER_RADIUS = 2.5;

/**
 * An inside corner is the dirt's corner, pushed `INSET` into the grass, rounded
 * to this radius. It has to stay under `INSET` × 3.4 or the curve would need
 * grass in the dirt cell, which draws none.
 */
const INNER_RADIUS = 6;
const INNER_CENTRE = INNER_RADIUS - INSET;

type Side = keyof typeof RAGGED;

type Corner = { x: 0 | 1; y: 0 | 1; row: Side; column: Side; diagonal: number };

const CORNERS: Corner[] = [
  { x: 0, y: 0, row: "n", column: "w", diagonal: NW },
  { x: 1, y: 0, row: "n", column: "e", diagonal: NE },
  { x: 0, y: 1, row: "s", column: "w", diagonal: SW },
  { x: 1, y: 1, row: "s", column: "e", diagonal: SE },
];

const SIDE_BIT: Record<Side, number> = { n: N, e: E, s: S, w: W };

function open(mask: number, side: Side): boolean {
  return (mask & SIDE_BIT[side]) === 0;
}

/**
 * Along an open side that turns into an inside corner, the dirt's edge is the
 * rounded corner rather than the ragged run, so the two meet without a step.
 */
function inInsideCorner(mask: number, side: Side, x: number, y: number): boolean {
  for (const corner of CORNERS) {
    const along = corner.row === side ? "x" : corner.column === side ? "y" : null;
    if (!along) continue;
    const other = along === "x" ? corner.column : corner.row;
    if (open(mask, other) || !(mask & corner.diagonal)) continue;
    const from = along === "x" ? x + 0.5 : y + 0.5;
    const distance = corner[along] === 0 ? from : CELL - from;
    if (distance < INNER_CENTRE) return true;
  }
  return false;
}

function raggedDirt(mask: number, x: number, y: number): boolean {
  const depths: Record<Side, { depth: number; along: number }> = {
    n: { depth: y, along: x },
    s: { depth: CELL - 1 - y, along: x },
    w: { depth: x, along: y },
    e: { depth: CELL - 1 - x, along: y },
  };
  for (const side of Object.keys(depths) as Side[]) {
    if (!open(mask, side) || inInsideCorner(mask, side, x, y)) continue;
    const { depth, along } = depths[side];
    if (depth < INSET + RAGGED[side][along]!) return true;
  }
  return false;
}

/**
 * `u` and `v` run from the corner into the cell. Both sides open rounds the
 * grass's own corner; one open side turning into grass, or both joined around
 * a missing diagonal, is a part of the rounded dirt corner described at
 * `INNER_RADIUS`.
 */
function cornerDirt(mask: number, corner: Corner, u: number, v: number): boolean {
  const rowOpen = open(mask, corner.row);
  const columnOpen = open(mask, corner.column);
  const diagonal = (mask & corner.diagonal) !== 0;
  if (rowOpen && columnOpen) {
    const centre = INSET + OUTER_RADIUS;
    return u < centre && v < centre && Math.hypot(u - centre, v - centre) > OUTER_RADIUS;
  }
  if (rowOpen !== columnOpen && diagonal) {
    const [along, depth] = rowOpen ? [u, v] : [v, u];
    if (along >= INNER_CENTRE || depth >= INSET) return false;
    return Math.hypot(along - INNER_CENTRE, depth + INNER_CENTRE) <= INNER_RADIUS;
  }
  if (!rowOpen && !columnOpen && !diagonal) {
    if (u >= INSET || v >= INSET) return false;
    return Math.hypot(u + INNER_CENTRE, v + INNER_CENTRE) <= INNER_RADIUS;
  }
  return false;
}

function shapeOf(mask: number): boolean[][] {
  return Array.from({ length: CELL }, (_, y) =>
    Array.from({ length: CELL }, (_, x) => {
      if (raggedDirt(mask, x, y)) return false;
      return !CORNERS.some((corner) => {
        const u = corner.x === 0 ? x + 0.5 : CELL - x - 0.5;
        const v = corner.y === 0 ? y + 0.5 : CELL - y - 0.5;
        return cornerDirt(mask, corner, u, v);
      });
    }),
  );
}

/**
 * Only the south and east rims are shaded, the sides the camera sees the grass
 * drop off. Off-tile pixels count as grass, so a joined side gets no rim.
 */
function rimOf(shape: boolean[][]): boolean[][] {
  const at = (x: number, y: number): boolean => (x >= CELL || y >= CELL ? true : shape[y]![x]!);
  return shape.map((row, y) => row.map((inside, x) => inside && (!at(x + 1, y) || !at(x, y + 1))));
}

async function readPng(file: string): Promise<PNG> {
  return PNG.sync.read(await fs.readFile(file));
}

function pixel(png: PNG, x: number, y: number): [number, number, number, number] {
  const i = (png.width * y + x) << 2;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!, png.data[i + 3]!];
}

function setPixel(png: PNG, x: number, y: number, rgba: readonly number[]) {
  const i = (png.width * y + x) << 2;
  png.data[i] = rgba[0]!;
  png.data[i + 1] = rgba[1]!;
  png.data[i + 2] = rgba[2]!;
  png.data[i + 3] = rgba[3]!;
}

function shaded([r, g, b, a]: readonly number[]): number[] {
  return [
    Math.round(r! * EDGE_SHADE),
    Math.round(g! * EDGE_SHADE),
    Math.round(b! * EDGE_SHADE),
    a!,
  ];
}

async function main() {
  const texture = await readPng(path.join(TILESETS, TEXTURE_FILE));
  const slices = Array.from({ length: RAW_MASK_COUNT }, (_, mask) => mask);

  const sheet = new PNG({ width: CELL, height: slices.length * CELL });
  sheet.data.fill(0);

  slices.forEach((slice, row) => {
    const shape = shapeOf(slice);
    const rim = rimOf(shape);

    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (!shape[y]![x]!) continue;
        const grass = pixel(texture, TEXTURE_CELL.x * CELL + x, TEXTURE_CELL.y * CELL + y);
        setPixel(sheet, x, row * CELL + y, rim[y]![x]! ? shaded(grass) : grass);
      }
    }
  });

  await fs.writeFile(path.join(TILESETS, `${TILESET_ID}.png`), PNG.sync.write(sheet));

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = JSON.parse(await fs.readFile(tilesPath, "utf8")) as TileDef[];
  const grass = tiles.find((t) => t.id === TILE_ID);
  if (!grass) throw new Error(`no ${TILE_ID} tile to point at the sheet`);

  grass.type = "autotile";
  grass.rawMaskSlices = true;
  grass.anchor = { tilesetId: TILESET_ID, x: 0, y: 0 };
  delete grass.sprite;
  grass.slices = Object.fromEntries(
    slices.map((slice, row): [number, TileSprite] => [
      slice,
      {
        frames: [
          {
            sprite: { rect: { x: 0, y: row, w: 1, h: 1 }, base: { x: 0, y: 0 } },
            durationMs: 200,
          },
        ],
      },
    ]),
  );

  const setsPath = path.join(DATA, "tilesets.json");
  const sets = JSON.parse(await fs.readFile(setsPath, "utf8")) as {
    id: string;
    name: string;
    file: string;
    width: number;
    height: number;
  }[];
  const existing = sets.find((s) => s.id === TILESET_ID);
  const entry = {
    id: TILESET_ID,
    name: "Grass",
    file: `${TILESET_ID}.png`,
    width: sheet.width,
    height: sheet.height,
  };
  if (existing) Object.assign(existing, entry);
  else sets.push(entry);

  await fs.writeFile(tilesPath, `${JSON.stringify(tiles, null, 2)}\n`);
  await fs.writeFile(setsPath, `${JSON.stringify(sets, null, 2)}\n`);

  console.log(
    `data/tilesets/${TILESET_ID}.png — ${sheet.width}x${sheet.height}, ${slices.length} slices`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
