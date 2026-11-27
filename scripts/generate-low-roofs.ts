import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { CELL_SIZE } from "../app/lib/types";
import {
  ALONG_X,
  ALONG_Y,
  EAVE_FACINGS,
  SPRITE_CELLS,
  type Rgba,
  type Surface,
  drawSprite,
  eaveSurface,
  frames,
  ridgeSurface,
  slopeFacing,
} from "./roof-caster";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const SHEET = path.join(DATA, "tilesets", "roofs.png");

/** Shingle, shadow, gap, highlight: the four roof colours `roof-1`, `roof-2` and `roof-4` are drawn in. */
type Shingles = { A: Rgba; B: Rgba; C: Rgba; F: Rgba };

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
  const { alongX, lit } = slopeFacing(surface, x, y);
  if (alongX) {
    const row = EAST_PATTERN[Math.floor(y)]!;
    const col = patternIndex(X, lit ? extents.east : extents.west, row.length);
    const shingle = row[col] as Shingle;
    return lit ? shingle : SHADE[shingle];
  }
  const row = patternIndex(Y, lit ? extents.south : extents.north, SOUTH_PATTERN.length);
  const shingle = SOUTH_PATTERN[row]![Math.floor(x)] as Shingle;
  return lit ? shingle : SHADE[shingle];
}

function shingled(surface: Surface, extents: SlopeExtents, shingles: Shingles) {
  return ({ x, y, X, Y }: { x: number; y: number; X: number; Y: number }) =>
    shingles[shingleAt(surface, x, y, X, Y, extents)];
}

const FIRST_COLUMN = 8;
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
      const surface = eaveSurface(facing, EAVE_RISE);
      drawSprite(
        sheet,
        at(block),
        top,
        surface,
        EAVE_RISE,
        lip,
        shingled(surface, EAVE_EXTENTS, shingles),
      );
    });
    const ridge = EAVE_FACINGS.length;
    const ns = ridgeSurface("ns", RIDGE_RISE);
    const ew = ridgeSurface("ew", RIDGE_RISE);
    drawSprite(
      sheet,
      at(ridge),
      top,
      ns,
      RIDGE_RISE,
      ALONG_Y,
      shingled(ns, RIDGE_EXTENTS, shingles),
    );
    drawSprite(
      sheet,
      at(ridge + 1),
      top,
      ew,
      RIDGE_RISE,
      ALONG_X,
      shingled(ew, RIDGE_EXTENTS, shingles),
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
