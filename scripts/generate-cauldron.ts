import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "cauldron";
const SOURCE = path.join(import.meta.dirname, "..", "data", "tilesets", "ultima-vi.png");

const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;

/** The full cauldron in the Ultima VI sheet, a 16-pixel cell, the size of our 2×2 sprite. */
const FROM = { x: 240, y: 336 };

/**
 * Each Ultima VI colour in the cauldron, as `rrggbb`, and the palette index it
 * becomes. The stew's four browns are kept apart so its texture survives.
 */
const RECOLOUR: Record<string, number> = {
  "000000": 0,
  "080808": 0,
  "202020": 1,
  "343434": 1,
  "545454": 4,
  "646464": 8,
  "747474": 22,
  "848484": 22,
  "989898": 25,
  a8a8a8: 25,
  b8b8b8: 25,
  d8d8d8: 27,
  fcfcfc: 28,
  "704820": 3,
  "84542c": 11,
  "9c6038": 11,
  b46c44: 13,
};

const STEW = new Set([3, 11, 13, 18]);
const BUBBLE = 19;
const BUBBLE_SHADE = 18;

/**
 * Where a bubble rises in each frame, in pixels of the sprite, and how big it
 * is: 0 starts as a speck, 1 swells, 2 pops into a ring. Every position is on
 * the stew.
 */
const FRAMES: { at: [number, number]; size: number }[][] = [
  [
    { at: [6, 5], size: 1 },
    { at: [9, 7], size: 0 },
  ],
  [
    { at: [6, 5], size: 2 },
    { at: [9, 7], size: 1 },
    { at: [5, 8], size: 0 },
  ],
  [
    { at: [9, 7], size: 2 },
    { at: [5, 8], size: 1 },
  ],
  [
    { at: [5, 8], size: 2 },
    { at: [6, 5], size: 0 },
  ],
];
const FRAME_MS = 250;

function hex(png: PNG, x: number, y: number): string | null {
  const i = (png.width * y + x) << 2;
  if (png.data[i + 3] === 0) return null;
  return [0, 1, 2].map((c) => png.data[i + c]!.toString(16).padStart(2, "0")).join("");
}

function recoloured(source: PNG): Int16Array {
  const out = new Int16Array(SPRITE_PX * SPRITE_PX).fill(-1);
  for (let y = 0; y < SPRITE_PX; y++) {
    for (let x = 0; x < SPRITE_PX; x++) {
      const colour = hex(source, FROM.x + x, FROM.y + y);
      if (colour === null) continue;
      const index = RECOLOUR[colour];
      if (index === undefined) throw new Error(`cauldron: no palette entry for #${colour}`);
      out[y * SPRITE_PX + x] = index;
    }
  }
  return out;
}

function onStew(pixels: Int16Array, x: number, y: number): boolean {
  return STEW.has(pixels[y * SPRITE_PX + x]!);
}

/** A bubble lit from the south-west: its highlight on the lower left, its shade on the upper right. */
function bubble(pixels: Int16Array, [x, y]: [number, number], size: number) {
  const put = (dx: number, dy: number, index: number) => {
    if (onStew(pixels, x + dx, y + dy)) pixels[(y + dy) * SPRITE_PX + x + dx] = index;
  };
  if (size === 0) return put(0, 0, BUBBLE);
  if (size === 1) {
    put(0, 0, BUBBLE);
    put(1, 0, BUBBLE_SHADE);
    put(0, -1, BUBBLE_SHADE);
    return;
  }
  put(-1, 0, BUBBLE);
  put(1, 0, BUBBLE_SHADE);
  put(0, -1, BUBBLE_SHADE);
  put(0, 1, BUBBLE);
}

function cauldronTile(): TileDef {
  const frames = FRAMES.map((_, column) => ({
    sprite: {
      rect: { x: column * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
      base: { x: SPRITE_CELLS - 1, y: SPRITE_CELLS - 1 },
    },
    durationMs: FRAME_MS,
  }));
  return {
    id: "cauldron",
    name: "Cauldron",
    height: 2,
    type: "simple",
    kind: "prop",
    attributes: {},
    lightPassing: true,
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    sprite: { frames },
  } as TileDef;
}

async function main() {
  const base = recoloured(PNG.sync.read(await fs.readFile(SOURCE)));
  const sheet = new PNG({ width: FRAMES.length * SPRITE_PX, height: SPRITE_PX });
  sheet.data.fill(0);
  for (const [column, bubbles] of FRAMES.entries()) {
    const pixels = base.slice();
    for (const { at, size } of bubbles) bubble(pixels, at, size);
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i]! < 0) continue;
      paint(sheet, column * SPRITE_PX + (i % SPRITE_PX), Math.floor(i / SPRITE_PX), pixels[i]!);
    }
  }
  await writeTileset(TILESET_ID, "Cauldron", sheet, [cauldronTile()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
