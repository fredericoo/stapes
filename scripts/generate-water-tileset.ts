import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { FULL_AUTOTILE_SLICE_COUNT, type TileDef, type TileSprite } from "../app/lib/types";
import { joinedByMask, outlineCoverage, type RoundedEdge } from "./rounded-edge";

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
/** `sand`'s own colour, so the bank meets the ground beside it without a seam. */
const SAND: [number, number, number, number] = [0xfb, 0xb9, 0x54, 255];
/** `sand`'s ripple colour, darkening the sand the water has just left. */
const WET_SAND: [number, number, number, number] = [0xe6, 0x90, 0x4e, 255];

const SHADOW: [number, number, number, number] = [0x24, 0x43, 0x6b, 255];
const BASE: [number, number, number, number] = [0x33, 0x5c, 0x8c, 255];
const HIGHLIGHT: [number, number, number, number] = [0x5b, 0x8f, 0xbf, 255];

const FRAME_MS = 80;

const PHASE = { x: 3, y: -1 };

const TILESET_ID = "water";
const TILE_ID = "water";

/**
 * A shadow on the left column or top row is cast from the neighbouring tile,
 * which is `PHASE` frames apart in the cycle, so the source frame is shifted by
 * that phase at those edges. Changing `PHASE` means regenerating the sheet.
 */
function shadowOf(litByFrame: boolean[][][], frame: number): boolean[][] {
  const count = litByFrame.length;
  const lit = litByFrame[frame]!;
  const out = lit.map((row) => row.map(() => false));
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (lit[y]![x]!) continue;
      const step = (x === 0 ? -PHASE.x : 0) + (y === 0 ? -PHASE.y : 0);
      const source = litByFrame[(((frame + step) % count) + count) % count]!;
      if (source[(y + CELL - 1) % CELL]![(x + CELL - 1) % CELL]!) {
        out[y]![x] = true;
      }
    }
  }
  return out;
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

async function main() {
  const waves = await readPng(path.join(ROOT, "scripts", "wave-frames.png"));

  const frameCount = waves.width / CELL;
  if (!Number.isInteger(frameCount) || waves.height !== CELL) {
    throw new Error(`wave-frames.png should be a row of ${CELL}px frames`);
  }
  const slices = Array.from({ length: FULL_AUTOTILE_SLICE_COUNT }, (_, mask) => mask);

  const sheet = new PNG({
    width: frameCount * CELL,
    height: slices.length * CELL,
  });
  sheet.data.fill(0);

  const litByFrame: boolean[][][] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    litByFrame.push(
      Array.from({ length: CELL }, (_, y) =>
        Array.from({ length: CELL }, (_, x) => pixel(waves, frame * CELL + x, y)[3] > 0),
      ),
    );
  }
  const shadowByFrame = litByFrame.map((_, frame) => shadowOf(litByFrame, frame));

  slices.forEach((mask, row) => {
    const joined = joinedByMask(mask);
    const water = outlineCoverage(joined, EDGE);
    const wet = outlineCoverage(joined, EDGE, -WET_PX);

    for (let frame = 0; frame < frameCount; frame++) {
      const lit = litByFrame[frame]!;
      const shade = shadowByFrame[frame]!;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const tone =
            water[y]![x]! >= 0.5
              ? lit[y]![x]!
                ? HIGHLIGHT
                : shade[y]![x]!
                  ? SHADOW
                  : BASE
              : wet[y]![x]! >= 0.5
                ? WET_SAND
                : SAND;
          setPixel(sheet, frame * CELL + x, row * CELL + y, tone);
        }
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
  delete water.sprite;
  water.slices = Object.fromEntries(
    slices.map((slice, row): [number, TileSprite] => [
      slice,
      {
        frames: Array.from({ length: frameCount }, (_, frame) => ({
          sprite: {
            tilesetId: TILESET_ID,
            rect: { x: frame, y: row, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: FRAME_MS,
        })),
        phase: PHASE,
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
    name: "Water",
    file: `${TILESET_ID}.png`,
    width: sheet.width,
    height: sheet.height,
  };
  if (existing) Object.assign(existing, entry);
  else sets.push(entry);

  await fs.writeFile(tilesPath, `${JSON.stringify(tiles, null, 2)}\n`);
  await fs.writeFile(setsPath, `${JSON.stringify(sets, null, 2)}\n`);

  console.log(
    `data/tilesets/${TILESET_ID}.png — ${sheet.width}x${sheet.height}, ` +
      `${slices.length} slices x ${frameCount} frames`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
