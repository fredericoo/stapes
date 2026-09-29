import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import type { Direction, TileDef } from "../app/lib/types";
import { CELL_SIZE } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const SHEET = path.join(DATA, "tilesets", "roofs.png");

type Rgba = readonly [number, number, number, number];

/** Shingle, shadow, gap, highlight: the four roof colours `roof-1`, `roof-2` and `roof-4` are drawn in. */
type Shingles = { A: Rgba; B: Rgba; C: Rgba; F: Rgba };

const SOUTH_GABLE: Rgba = [255, 255, 255, 255];
const EAST_GABLE: Rgba = [199, 220, 208, 255];

const COLOURS: { name: string; shingles: Shingles }[] = [
  {
    name: "red",
    shingles: {
      A: [188, 52, 0, 255],
      B: [152, 28, 0, 255],
      C: [110, 39, 39, 255],
      F: [232, 59, 59, 255],
    },
  },
  {
    name: "yellow",
    shingles: {
      A: [230, 144, 78, 255],
      B: [148, 100, 60, 255],
      C: [104, 72, 36, 255],
      F: [232, 168, 104, 255],
    },
  },
  {
    name: "blue",
    shingles: {
      A: [77, 101, 180, 255],
      B: [72, 74, 119, 255],
      C: [46, 34, 47, 255],
      F: [77, 155, 230, 255],
    },
  },
];

type Shingle = keyof Shingles;

/**
 * Copied from `roof-1`'s south-facing slope: rows run down the slope in screen
 * pixels and columns along the ridge in world pixels. Four rows are one course,
 * each laid half a shingle along from the last.
 */
const SOUTH_PATTERN = [
  "ABBBABBB",
  "AAACAAAB",
  "BCCCBCCC",
  "BBBBBBBB",
  "BABBBABB",
  "CAAACAAA",
  "CBCCCBCC",
  "BBBBBBBB",
  "BBABBBAB",
  "ACAAACAA",
  "CCBCCCBC",
  "BBBBBBBB",
  "BABBBABB",
  "CAAACAAB",
  "CBCCCBCC",
  "BBBBBBBB",
];

/** Copied from `roof-1`'s east-facing slope: rows run along the ridge, columns down the slope. */
const EAST_PATTERN = [
  "AFBAFFAAABBAAFBA",
  "AFBAAFBAFFAAABBA",
  "ABBAAFBAAFBAFFAA",
  "FFAAABBAAFBAAFBA",
  "AFBAFFAAABBAAFBA",
  "AFBAAFBAFFAAABBA",
  "ABBAAFBAAFBAFFAA",
  "FFAAAABAAFBAAABA",
];

/** A slope facing north or west is turned from the light, one step darker. */
const SHADE: Record<Shingle, Shingle> = { A: "B", B: "C", C: "C", F: "A" };

const EAVE_RISE = 2;
const RIDGE_RISE = 1;

type Surface = (x: number, y: number) => number;

function eaveSurface(facing: Direction): Surface {
  const run = CELL_SIZE / EAVE_RISE;
  switch (facing) {
    case "e":
      return (x) => x / run;
    case "w":
      return (x) => (CELL_SIZE - x) / run;
    case "s":
      return (_, y) => y / run;
    case "n":
      return (_, y) => (CELL_SIZE - y) / run;
  }
}

function ridgeSurface(axis: "ns" | "ew"): Surface {
  const half = CELL_SIZE / 2;
  return axis === "ns"
    ? (x) => RIDGE_RISE * (1 - Math.abs(x - half) / half)
    : (_, y) => RIDGE_RISE * (1 - Math.abs(y - half) / half);
}

type Hit = { face: "top" | "south" | "east"; x: number; y: number };

const clampToCell = (v: number) => Math.min(Math.max(v, 0), CELL_SIZE - 1e-3);

/**
 * Marches the view ray from the top of the tile down until it enters the solid
 * under `surface`. A point `h` units up draws `PX_PER_HEIGHT * h` px up and to
 * the left, so the ray through a screen pixel is `(X + 2h, Y + 2h, h)`.
 *
 * The slope runs `lip` px past the cell's north or west edge, over the gable of
 * the cell before it along the ridge. Rasterised separately, that gable and this
 * slope's edge land on different pixels, and a line of gable shows between them.
 */
function cast(surface: Surface, top: number, X: number, Y: number, lip: Lip): Hit | null {
  let prev: { x: number; y: number } | null = null;
  for (let h = top + 0.01; h >= 0; h -= 0.005) {
    const x = X + PX_PER_HEIGHT * h;
    const y = Y + PX_PER_HEIGHT * h;
    const inside =
      x >= -lip.x &&
      x < CELL_SIZE &&
      y >= -lip.y &&
      y < CELL_SIZE &&
      h <= surface(clampToCell(x), clampToCell(y));
    if (inside) {
      if (prev && prev.y >= CELL_SIZE) return { face: "south", x, y };
      if (prev && prev.x >= CELL_SIZE) return { face: "east", x, y };
      return { face: "top", x, y };
    }
    prev = { x, y };
  }
  return null;
}

/** Where each facing's slope starts on screen and how wide it is there, so its pattern is laid from the eave. */
type Extents = { start: number; width: number };
type SlopeExtents = Record<"east" | "west" | "south" | "north", Extents>;

const EAVE_EXTENTS: SlopeExtents = {
  east: { start: -4, width: 12 },
  west: { start: 0, width: 4 },
  south: { start: -4, width: 12 },
  north: { start: 0, width: 4 },
};

const RIDGE_EXTENTS: SlopeExtents = {
  east: { start: 2, width: 6 },
  west: { start: 0, width: 2 },
  south: { start: 2, width: 6 },
  north: { start: 0, width: 2 },
};

function patternIndex(at: number, { start, width }: Extents, length: number): number {
  return Math.min(Math.max(Math.floor(at - start) + (length - width), 0), length - 1);
}

function shingleAt(
  surface: Surface,
  x: number,
  y: number,
  X: number,
  Y: number,
  extents: SlopeExtents,
): Shingle {
  const e = 0.01;
  const slopeX = surface(clampToCell(x + e), y) - surface(clampToCell(x - e), y);
  const slopeY = surface(x, clampToCell(y + e)) - surface(x, clampToCell(y - e));
  if (Math.abs(slopeX) >= Math.abs(slopeY)) {
    const row = EAST_PATTERN[Math.floor(y)]!;
    const facesEast = slopeX < 0;
    const col = patternIndex(X, facesEast ? extents.east : extents.west, row.length);
    const shingle = row[col] as Shingle;
    return facesEast ? shingle : SHADE[shingle];
  }
  const facesSouth = slopeY < 0;
  const row = patternIndex(Y, facesSouth ? extents.south : extents.north, SOUTH_PATTERN.length);
  const shingle = SOUTH_PATTERN[row]![Math.floor(x)] as Shingle;
  return facesSouth ? shingle : SHADE[shingle];
}

type Lip = { x: number; y: number };
const ALONG_X: Lip = { x: 1, y: 0 };
const ALONG_Y: Lip = { x: 0, y: 1 };

const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;

function drawSprite(
  sheet: PNG,
  left: number,
  top: number,
  surface: Surface,
  rise: number,
  extents: SlopeExtents,
  lip: Lip,
  shingles: Shingles,
) {
  const mod = (v: number) => ((v % CELL_SIZE) + CELL_SIZE) % CELL_SIZE;
  for (let sy = 0; sy < SPRITE_PX; sy++) {
    for (let sx = 0; sx < SPRITE_PX; sx++) {
      const X = sx - CELL_SIZE + 0.5;
      const Y = sy - CELL_SIZE + 0.5;
      const hit = cast(surface, rise, X, Y, lip);
      let rgba: Rgba = [0, 0, 0, 0];
      if (hit?.face === "south") rgba = SOUTH_GABLE;
      else if (hit?.face === "east") rgba = EAST_GABLE;
      else if (hit) rgba = shingles[shingleAt(surface, mod(hit.x), mod(hit.y), X, Y, extents)];
      const i = ((top + sy) * sheet.width + left + sx) * 4;
      for (let c = 0; c < 4; c++) sheet.data[i + c] = rgba[c]!;
    }
  }
}

const FIRST_COLUMN = 8;
const EAVE_FACINGS: Direction[] = ["n", "e", "s", "w"];

function frames(x: number, y: number) {
  return {
    frames: [
      {
        sprite: {
          rect: { x, y, w: SPRITE_CELLS, h: SPRITE_CELLS },
          base: { x: 1, y: 1 },
        },
        durationMs: 200,
      },
    ],
  };
}

function tileDefs(name: string, row: number): TileDef[] {
  const eave = {
    id: `low-roof-${name}`,
    name: "Low Roof",
    height: EAVE_RISE,
    type: "directional",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "roofs", x: FIRST_COLUMN, y: row },
    intangible: true,
    sprites: Object.fromEntries(
      EAVE_FACINGS.map((facing, i) => [facing, frames(i * SPRITE_CELLS, 0)]),
    ),
  };
  const ridge = {
    id: `low-roof-${name}-ridge`,
    name: "Low Roof",
    height: RIDGE_RISE,
    type: "directional",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "roofs", x: FIRST_COLUMN + EAVE_FACINGS.length * SPRITE_CELLS, y: row },
    sprites: {
      n: frames(0, 0),
      e: frames(SPRITE_CELLS, 0),
      s: frames(0, 0),
      w: frames(SPRITE_CELLS, 0),
    },
  };
  return [eave, ridge] as unknown as TileDef[];
}

async function main() {
  const sheet = PNG.sync.read(await fs.readFile(SHEET));
  const defs: TileDef[] = [];

  COLOURS.forEach(({ name, shingles }, i) => {
    const row = i * SPRITE_CELLS;
    const top = row * CELL_SIZE;
    const at = (block: number) => (FIRST_COLUMN + block * SPRITE_CELLS) * CELL_SIZE;
    EAVE_FACINGS.forEach((facing, block) => {
      const lip = facing === "n" || facing === "s" ? ALONG_X : ALONG_Y;
      drawSprite(
        sheet,
        at(block),
        top,
        eaveSurface(facing),
        EAVE_RISE,
        EAVE_EXTENTS,
        lip,
        shingles,
      );
    });
    const ridge = EAVE_FACINGS.length;
    drawSprite(
      sheet,
      at(ridge),
      top,
      ridgeSurface("ns"),
      RIDGE_RISE,
      RIDGE_EXTENTS,
      ALONG_Y,
      shingles,
    );
    drawSprite(
      sheet,
      at(ridge + 1),
      top,
      ridgeSurface("ew"),
      RIDGE_RISE,
      RIDGE_EXTENTS,
      ALONG_X,
      shingles,
    );
    defs.push(...tileDefs(name, row));
  });

  await fs.writeFile(SHEET, PNG.sync.write(sheet));

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = JSON.parse(await fs.readFile(tilesPath, "utf8")) as TileDef[];
  for (const def of defs) {
    const at = tiles.findIndex((t) => t.id === def.id);
    if (at >= 0) tiles[at] = def;
    else tiles.splice(tiles.findIndex((t) => t.id === "roof-6") + 1 + defs.indexOf(def), 0, def);
  }
  await fs.writeFile(tilesPath, `${JSON.stringify(tiles, null, 2)}\n`);
}

await main();
