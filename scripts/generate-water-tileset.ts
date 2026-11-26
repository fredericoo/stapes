import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import {
  FULL_AUTOTILE_SLICE_COUNT,
  type TileColorCycle,
  type TileDef,
  type TileSprite,
} from "../app/lib/types";
import { joinedByMask, outlineCoverage, type RoundedEdge } from "./rounded-edge";
import { cycleRamp } from "./water-ramps";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const TILESETS = path.join(DATA, "tilesets");

const CELL = 8;

/**
 * The water stops `inset` pixels short of any cell that holds no water, and
 * the rest of its cell is a sandy bank, so a river or a pond is drawn the same
 * on whatever ground it is laid on. 4 and 6 are the largest rounding that
 * still leaves every cell's outline readable from its eight neighbours
 * (`masksReadingTooFar`).
 */
const EDGE: RoundedEdge = { inset: 2, outerRound: 4, blend: 6 };
/** The wet line is this much wider than the water, round the whole bank. */
const WET_PX = 1;
/** Past the wet line the bank is left out, so the ground the water lies on shows round it. */
const BANK: [number, number, number, number] = [0, 0, 0, 0];
/**
 * Black over 30% of whatever is under it, the ground the water has just left.
 * The palette pass snaps the blend to that ground's own darker shade, so one
 * line suits sand, grass and snow alike, as `grass`'s shadow does.
 */
const WET: [number, number, number, number] = [0, 0, 0, Math.round(0.3 * 255)];

const SHADOW = "#24436b";
const BASE = "#335c8c";
const HIGHLIGHT = "#5b8fbf";
const KEY: [number, number, number, number] = [0x33, 0x5c, 0x8c, 255];

/**
 * A long run of the body colour, then a trough and a crest, so each cycle
 * reads as one wave with open water between it and the next. The crest leads:
 * bands move towards the end of the ramp.
 */
export const WATER_CYCLE: TileColorCycle = {
  key: BASE,
  ramp: cycleRamp([
    [BASE, 9],
    [SHADOW, 2],
    [BASE, 1],
    [HIGHLIGHT, 2],
    [BASE, 2],
  ]),
  cellsPerCycle: 4,
  msPerCycle: 1600,
  ripple: 8,
  gaps: 0.45,
};

/** One still frame: the shader moves the water. 200 is what every other one-frame tile in the catalogue lasts. */
const STILL_MS = 200;

const TILESET_ID = "water";
const TILE_ID = "water";

function setPixel(png: PNG, x: number, y: number, rgba: readonly number[]) {
  const i = (png.width * y + x) << 2;
  png.data[i] = rgba[0]!;
  png.data[i + 1] = rgba[1]!;
  png.data[i + 2] = rgba[2]!;
  png.data[i + 3] = rgba[3]!;
}

async function main() {
  const slices = Array.from({ length: FULL_AUTOTILE_SLICE_COUNT }, (_, mask) => mask);
  const sheet = new PNG({ width: CELL, height: slices.length * CELL });
  sheet.data.fill(0);

  slices.forEach((mask, row) => {
    const joined = joinedByMask(mask);
    const water = outlineCoverage(joined, EDGE);
    const wet = outlineCoverage(joined, EDGE, -WET_PX);
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const tone = water[y]![x]! >= 0.5 ? KEY : wet[y]![x]! >= 0.5 ? WET : BANK;
        setPixel(sheet, x, row * CELL + y, tone);
      }
    }
  });

  await fs.writeFile(path.join(TILESETS, `${TILESET_ID}.png`), PNG.sync.write(sheet));

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = JSON.parse(await fs.readFile(tilesPath, "utf8")) as TileDef[];
  const water = tiles.find((t) => t.id === TILE_ID);
  if (!water) throw new Error(`no ${TILE_ID} tile to point at the sheet`);

  water.type = "autotile";
  water.autotileMask = "full";
  water.colorCycle = WATER_CYCLE;
  delete water.sprite;
  water.slices = Object.fromEntries(
    slices.map((slice, row): [number, TileSprite] => [
      slice,
      {
        frames: [
          {
            sprite: {
              rect: { x: 0, y: row, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: STILL_MS,
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
    translucent?: boolean;
  }[];
  const existing = sets.find((s) => s.id === TILESET_ID);
  const entry = {
    id: TILESET_ID,
    name: "Water",
    file: `${TILESET_ID}.png`,
    width: sheet.width,
    height: sheet.height,
    translucent: true,
  };
  if (existing) Object.assign(existing, entry);
  else sets.push(entry);

  await fs.writeFile(tilesPath, `${JSON.stringify(tiles, null, 2)}\n`);
  await fs.writeFile(setsPath, `${JSON.stringify(sets, null, 2)}\n`);

  console.log(
    `data/tilesets/${TILESET_ID}.png — ${sheet.width}x${sheet.height}, ${slices.length} slices`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
