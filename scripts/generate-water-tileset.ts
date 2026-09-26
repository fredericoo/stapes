import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import type { TileDef, TileSprite } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const TILESETS = path.join(DATA, "tilesets");

const CELL = 8;

const SHAPE_BLOCK_X = 4;

const SHAPE_FILL: [number, number, number] = [35, 144, 99];

const SHADOW: [number, number, number, number] = [0x24, 0x43, 0x6b, 255];
const BASE: [number, number, number, number] = [0x33, 0x5c, 0x8c, 255];
const HIGHLIGHT: [number, number, number, number] = [0x5b, 0x8f, 0xbf, 255];

const BANK_DEPTH = 2;

const FRAME_MS = 80;

const PHASE = { x: 3, y: -1 };

const SHAPE_SOURCE_TILE = "dirt";

const TILESET_ID = "water";
const TILE_ID = "water";

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

const CORNERS: {
  needs: number;
  missing: number;
  x: number;
  y: number;
  casts: boolean;
}[] = [
  { needs: N | W, missing: NW, x: 0, y: 0, casts: true },
  { needs: N | E, missing: NE, x: CELL - 1, y: 0, casts: true },
  { needs: S | W, missing: SW, x: 0, y: CELL - 1, casts: false },
  { needs: S | E, missing: SE, x: CELL - 1, y: CELL - 1, casts: false },
];

function nickCorners(inside: boolean[][], mask: number, casting = false): boolean[][] {
  const out = inside.map((row) => [...row]);
  for (const corner of CORNERS) {
    if (casting && !corner.casts) continue;
    const bothEdges = (mask & corner.needs) === corner.needs;
    if (!bothEdges || mask & corner.missing) continue;
    out[corner.y]![corner.x] = false;
  }
  return out;
}

function bankOf(shape: boolean[][], inside: boolean[][]): boolean[][] {
  const at = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= CELL || y >= CELL ? true : shape[y]![x]!;
  const out = shape.map((row) => row.map(() => false));
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (!inside[y]![x]!) continue;
      for (let dy = 0; dy <= BANK_DEPTH && !out[y]![x]; dy++) {
        for (let dx = 0; dx <= BANK_DEPTH; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!at(x - dx, y - dy)) {
            out[y]![x] = true;
            break;
          }
        }
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

async function sliceCells(): Promise<Map<number, { x: number; y: number }>> {
  const tiles = JSON.parse(await fs.readFile(path.join(DATA, "tiles.json"), "utf8")) as TileDef[];
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

  slices.forEach((slice, row) => {
    const cell = cells.get(slice)!;
    const inside = Array.from({ length: CELL }, (_, y) =>
      Array.from({ length: CELL }, (_, x) => {
        const [r, g, b, a] = pixel(floors, (SHAPE_BLOCK_X + cell.x) * CELL + x, cell.y * CELL + y);
        return a > 0 && r === SHAPE_FILL[0] && g === SHAPE_FILL[1] && b === SHAPE_FILL[2];
      }),
    );
    const mask = AUTOTILE_SLICE_MASKS[slice]!;
    const shape = nickCorners(inside, mask);
    const bank = bankOf(nickCorners(inside, mask, true), shape);

    for (let frame = 0; frame < frameCount; frame++) {
      const lit = litByFrame[frame]!;
      const shade = shadowByFrame[frame]!;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          if (!shape[y]![x]!) continue;
          const tone = bank[y]![x]!
            ? SHADOW
            : lit[y]![x]!
              ? HIGHLIGHT
              : shade[y]![x]!
                ? SHADOW
                : BASE;
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
