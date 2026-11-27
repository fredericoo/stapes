import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { CELL_SIZE } from "../app/lib/types";
import {
  ALONG_X,
  EAST_GABLE,
  SOUTH_GABLE,
  ALONG_Y,
  EAVE_FACINGS,
  SPRITE_CELLS,
  type Rgba,
  type SlopeHit,
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

const rgba = (hex: string): Rgba => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};

/** Straw, the darker strands in it, the shadow under each course, and moss; lit and turned from the light. */
const LIT = {
  straw: rgba("#fbb954"),
  strand: rgba("#e6904e"),
  course: rgba("#cd683d"),
  moss: rgba("#91db69"),
};
const SHADED = {
  straw: rgba("#e6904e"),
  strand: rgba("#cd683d"),
  course: rgba("#9e4539"),
  moss: rgba("#239063"),
};

/** Screen pixels down the slope from one course of bundles to the next. */
const COURSE = 3;

/** A hash of a cell of the pattern into 0..1, so the strands and moss fall the same on every run. */
function noise(a: number, b: number, salt: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Bundles of straw laid in courses down the slope. Along the ridge each world
 * pixel is one strand; down the slope a course ends every `COURSE` screen
 * pixels in a ragged line of shadow, and moss takes hold here and there.
 */
function thatch(surface: Surface) {
  return ({ x, y, X, Y }: SlopeHit): Rgba => {
    const { alongX, lit } = slopeFacing(surface, x, y);
    const colours = lit ? LIT : SHADED;
    const strand = Math.floor(alongX ? y : x);
    const down = Math.floor(alongX ? X : Y) + CELL_SIZE;
    const course = Math.floor(down / COURSE);
    const inCourse = down % COURSE;
    if (inCourse === COURSE - 1 && noise(strand, course, 1) > 0.25) return colours.course;
    if (inCourse > 0 && noise(strand >> 1, course, 2) < 0.07) return colours.moss;
    return noise(strand, course, 3) < 0.35 ? colours.strand : colours.straw;
  };
}

const PITCHES = [
  {
    name: "steep",
    eaveRise: 4,
    ridgeRise: 2,
    row: 8,
    eaveId: "thatch-roof",
    ridgeId: "thatch-roof-ridge",
    outline: { eave: "roof-1", ridge: "roof-3" },
  },
  {
    name: "low",
    eaveRise: 2,
    ridgeRise: 1,
    row: 10,
    eaveId: "low-roof-thatch",
    ridgeId: "low-roof-thatch-ridge",
    outline: null,
  },
] as const;

const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;
const same = (a: Rgba, b: Rgba) => a.every((v, i) => v === b[i]);

/** The pixel of a tile's hand-drawn sprite for `facing` that lands where pixel `sx`, `sy` of a 2×2 sprite based at 1,1 does. */
function handPixel(sheet: PNG, tile: TileDef, facing: string, sx: number, sy: number): Rgba {
  const sprite = (
    tile.sprites as Record<string, { frames: { sprite: { rect: Rect; base: Point } }[] }>
  )[facing]!.frames[0]!.sprite;
  const { rect, base } = sprite;
  const px = sx - CELL_SIZE + base.x * CELL_SIZE;
  const py = sy - CELL_SIZE + base.y * CELL_SIZE;
  if (px < 0 || py < 0 || px >= rect.w * CELL_SIZE || py >= rect.h * CELL_SIZE) return [0, 0, 0, 0];
  const x = (tile.anchor!.x + rect.x) * CELL_SIZE + px;
  const y = (tile.anchor!.y + rect.y) * CELL_SIZE + py;
  const i = (y * sheet.width + x) * 4;
  return [sheet.data[i]!, sheet.data[i + 1]!, sheet.data[i + 2]!, sheet.data[i + 3]!];
}

type Rect = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };

/**
 * A steep eave rises a level a cell, the slope of the view ray, so the slopes
 * facing north and west are seen edge on and a cast draws nothing of them.
 * The steep thatch takes its outline from the hand-drawn shingle roof
 * instead: where that draws roof, the cast's thatch shows, and where the cast
 * has only gable there, the line of roof edge is drawn in the courses' shadow.
 */
function outlineWith(sheet: PNG, left: number, top: number, hand: TileDef, facing: string) {
  for (let sy = 0; sy < SPRITE_PX; sy++) {
    for (let sx = 0; sx < SPRITE_PX; sx++) {
      const want = handPixel(sheet, hand, facing, sx, sy);
      const i = ((top + sy) * sheet.width + left + sx) * 4;
      const cast: Rgba = [
        sheet.data[i]!,
        sheet.data[i + 1]!,
        sheet.data[i + 2]!,
        sheet.data[i + 3]!,
      ];
      const handRoof = want[3] > 0 && !same(want, SOUTH_GABLE) && !same(want, EAST_GABLE);
      const castRoof = cast[3] > 0 && !same(cast, SOUTH_GABLE) && !same(cast, EAST_GABLE);
      const out = handRoof ? (castRoof ? cast : SHADED.course) : want;
      for (let c = 0; c < 4; c++) sheet.data[i + c] = out[c]!;
    }
  }
}

const SHEET_ROWS = 12;

function tileDefs(pitch: (typeof PITCHES)[number]): TileDef[] {
  const name = pitch.name === "steep" ? "Thatched Roof" : "Low Thatched Roof";
  const eave = {
    id: pitch.eaveId,
    name,
    height: pitch.eaveRise,
    type: "directional",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "roofs", x: 0, y: pitch.row },
    intangible: true,
    sprites: Object.fromEntries(
      EAVE_FACINGS.map((facing, i) => [facing, frames(i * SPRITE_CELLS, 0)]),
    ),
  };
  const ridge = {
    id: pitch.ridgeId,
    name,
    height: pitch.ridgeRise,
    type: "directional",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "roofs", x: EAVE_FACINGS.length * SPRITE_CELLS, y: pitch.row },
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
  const old = PNG.sync.read(await fs.readFile(SHEET));
  const sheet = new PNG({ width: old.width, height: Math.max(old.height, SHEET_ROWS * CELL_SIZE) });
  PNG.bitblt(old, sheet, 0, 0, old.width, old.height, 0, 0);
  const defs: TileDef[] = [];
  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = JSON.parse(await fs.readFile(tilesPath, "utf8")) as TileDef[];
  const tile = (id: string) => tiles.find((t) => t.id === id)!;

  for (const pitch of PITCHES) {
    const top = pitch.row * CELL_SIZE;
    const at = (block: number) => block * SPRITE_CELLS * CELL_SIZE;
    EAVE_FACINGS.forEach((facing, block) => {
      const lip = facing === "n" || facing === "s" ? ALONG_X : ALONG_Y;
      const surface = eaveSurface(facing, pitch.eaveRise);
      drawSprite(sheet, at(block), top, surface, pitch.eaveRise, lip, thatch(surface));
      if (pitch.outline) outlineWith(sheet, at(block), top, tile(pitch.outline.eave), facing);
    });
    const ridge = EAVE_FACINGS.length;
    const ns = ridgeSurface("ns", pitch.ridgeRise);
    const ew = ridgeSurface("ew", pitch.ridgeRise);
    drawSprite(sheet, at(ridge), top, ns, pitch.ridgeRise, ALONG_Y, thatch(ns));
    drawSprite(sheet, at(ridge + 1), top, ew, pitch.ridgeRise, ALONG_X, thatch(ew));
    if (pitch.outline) {
      outlineWith(sheet, at(ridge), top, tile(pitch.outline.ridge), "n");
      outlineWith(sheet, at(ridge + 1), top, tile(pitch.outline.ridge), "e");
    }
    defs.push(...tileDefs(pitch));
  }

  await fs.writeFile(SHEET, PNG.sync.write(sheet));

  const tilesetsPath = path.join(DATA, "tilesets.json");
  const tilesets = JSON.parse(await fs.readFile(tilesetsPath, "utf8")) as {
    id: string;
    height: number;
  }[];
  const roofs = tilesets.find((t) => t.id === "roofs");
  if (roofs) roofs.height = sheet.height;
  await fs.writeFile(tilesetsPath, `${JSON.stringify(tilesets, null, 2)}\n`);

  for (const def of defs) {
    const at = tiles.findIndex((t) => t.id === def.id);
    if (at >= 0) tiles[at] = def;
    else {
      const after = tiles.findIndex((t) => t.id === "low-roof-blue-ridge");
      tiles.splice(after + 1 + defs.indexOf(def), 0, def);
    }
  }
  await fs.writeFile(tilesPath, `${JSON.stringify(tiles, null, 2)}\n`);
}

await main();
