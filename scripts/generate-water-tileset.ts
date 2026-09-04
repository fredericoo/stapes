/**
 * Builds `data/tilesets/water.png` — the water autotile — and rewrites the
 * `water` tile's slices in `data/tiles.json` to match.
 *
 * Two masks make the art, and neither is drawn by hand:
 *
 * - **The wave**, `scripts/wave-frames.png`: fourteen 8x8 frames recovered from
 *   an old screen recording, white where the wave catches the light and
 *   transparent where it does not. This is the source of truth for the
 *   animation, and the reason it lives beside this script rather than in
 *   `data/tilesets/` is that it is not a tileset — nothing draws it.
 * - **The shape**, the green autotile block in `data/tilesets/floors.png`: its
 *   green pixels say which part of each of the 47 neighbourhoods is *inside* the
 *   material. Reused rather than redrawn because a pond's rim has to tuck itself
 *   into its neighbours exactly the way the ground autotiles already do, and two
 *   hand-drawn versions of that would drift apart.
 *
 * Which of the sixteen source cells each slice takes comes from `dirt`, the
 * autotile already laid out on this sheet. Reading it rather than restating it
 * means the water and the ground can never disagree about what slice 23 is.
 *
 * Run: bun run generate:water
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { TileDef, TileSprite } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const TILESETS = path.join(DATA, "tilesets");

const CELL = 8;

/** Where the green block sits in `floors.png`, in cells. */
const SHAPE_BLOCK_X = 4;

/** The green block's fill. Anything else in a source cell is outside the shape. */
const SHAPE_FILL: [number, number, number] = [35, 144, 99];

/**
 * The two tones the water is drawn in.
 *
 * The slab water already was, and a highlight lifted by the delta the recording
 * showed between its own base and its own wave — so the tile reads as this
 * game's water rather than importing the recording's much brighter cyan. Both
 * keep the slab's alpha, so water still lies over the ground rather than
 * replacing it.
 */
const BASE: [number, number, number, number] = [50, 51, 83, 210];
const HIGHLIGHT: [number, number, number, number] = [61, 83, 111, 210];

/** Frame cadence, in milliseconds. 12.5fps — what the recording was captured at. */
const FRAME_MS = 80;

/**
 * How far the cycle advances per cell, east and south.
 *
 * The vector the recording itself used. Without it every cell of a pond shows
 * the same frame and the whole thing blinks as one; with it the wave travels
 * diagonally across the water. See `SpritePhase`.
 */
const PHASE = { x: 3, y: -1 };

/** The autotile whose slice layout the water borrows. */
const SHAPE_SOURCE_TILE = "dirt";

const TILESET_ID = "water";
const TILE_ID = "water";

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

/** The 4x4 source cell each of the 47 slices takes, read off the ground autotile. */
async function sliceCells(): Promise<Map<number, { x: number; y: number }>> {
  const tiles = JSON.parse(
    await fs.readFile(path.join(DATA, "tiles.json"), "utf8"),
  ) as TileDef[];
  const source = tiles.find((t) => t.id === SHAPE_SOURCE_TILE);
  if (!source?.slices) throw new Error(`no slices on ${SHAPE_SOURCE_TILE}`);

  const out = new Map<number, { x: number; y: number }>();
  for (const [key, sprite] of Object.entries(source.slices)) {
    const rect = sprite?.frames[0]?.sprite.rect;
    if (!rect) continue;
    if (rect.w !== 1 || rect.h !== 1) {
      throw new Error(`slice ${key} of ${SHAPE_SOURCE_TILE} is not one cell`);
    }
    out.set(Number(key), { x: rect.x, y: rect.y });
  }
  return out;
}

async function main() {
  const waves = await readPng(path.join(ROOT, "scripts", "wave-frames.png"));
  const floors = await readPng(path.join(TILESETS, "floors.png"));
  const cells = await sliceCells();

  const frameCount = waves.width / CELL;
  if (!Number.isInteger(frameCount) || waves.height !== CELL) {
    throw new Error(`wave-frames.png should be a row of ${CELL}px frames`);
  }
  const slices = [...cells.keys()].sort((a, b) => a - b);

  // A frame across, a slice down. Nothing depends on that orientation beyond
  // the rects written below, but a row per slice keeps one neighbourhood's
  // fourteen frames on one line of the sheet, which is what you want to be
  // looking at when a slice is wrong.
  const sheet = new PNG({
    width: frameCount * CELL,
    height: slices.length * CELL,
  });
  sheet.data.fill(0);

  slices.forEach((slice, row) => {
    const cell = cells.get(slice)!;
    for (let frame = 0; frame < frameCount; frame++) {
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const [r, g, b, a] = pixel(
            floors,
            (SHAPE_BLOCK_X + cell.x) * CELL + x,
            cell.y * CELL + y,
          );
          const inside =
            a > 0 && r === SHAPE_FILL[0] && g === SHAPE_FILL[1] && b === SHAPE_FILL[2];
          if (!inside) continue;
          const lit = pixel(waves, frame * CELL + x, y)[3] > 0;
          setPixel(sheet, frame * CELL + x, row * CELL + y, lit ? HIGHLIGHT : BASE);
        }
      }
    }
  });

  await fs.writeFile(path.join(TILESETS, `${TILESET_ID}.png`), PNG.sync.write(sheet));

  // The tile and the sheet are written together on purpose: a slice's rect is a
  // coordinate in the image this run just produced, so anything that reads one
  // without the other is reading a stale half.
  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = JSON.parse(await fs.readFile(tilesPath, "utf8")) as TileDef[];
  const water = tiles.find((t) => t.id === TILE_ID);
  if (!water) throw new Error(`no ${TILE_ID} tile to point at the sheet`);

  water.type = "autotile";
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
