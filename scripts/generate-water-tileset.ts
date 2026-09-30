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

/**
 * The north-west quarter of a corner, for an outer corner (neither edge filled)
 * and an inner one (both edges filled, the diagonal not); the other three
 * corners are these mirrored. An inner corner can curve only as far as the
 * margin, because the slices beside it cannot see the diagonal and run their
 * margin straight up to the seam, which is why every margin meets a seam at 2px.
 */
const ROUND_CORNER: Record<"open" | "inner", string[]> = {
  open: ["....", "....", "...#", "..##"],
  inner: ["..##", ".###", "####", "####"],
};

/**
 * How far in from each open side the shore sits, pixel by pixel along it (west
 * to east, north to south). The ends are the 2px every seam expects; only the
 * middle wanders, and each side differently, so rotated slices do not repeat.
 */
const SHORE_DEPTH: {
  side: number;
  depth: number[];
  at: (x: number, y: number) => [number, number];
}[] = [
  { side: N, depth: [2, 2, 3, 2, 1, 2, 2, 2], at: (x, y) => [x, y] },
  { side: E, depth: [2, 2, 1, 2, 3, 3, 2, 2], at: (x, y) => [y, CELL - 1 - x] },
  { side: S, depth: [2, 2, 2, 1, 2, 3, 2, 2], at: (x, y) => [x, CELL - 1 - y] },
  { side: W, depth: [2, 2, 3, 3, 2, 1, 2, 2], at: (x, y) => [y, x] },
];

const HALF = CELL / 2;

type Shapes = { shape: boolean[][]; casting: boolean[][] };

type Variant = {
  tileId: string;
  tilesetId: string;
  name: string;
  shapes: (mask: number, floors: PNG, cell: { x: number; y: number }) => Shapes;
};

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

/**
 * Off-tile pixels count as inside the water, so open water gets no bank and an
 * edge slice is shaded only where its own shape cuts in.
 */
function bankOf(shape: boolean[][], inside: boolean[][]): boolean[][] {
  const at = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= CELL || y >= CELL ? true : shape[y]![x]!;
  const groundUpLeft = (x: number, y: number): boolean => {
    for (let dy = 0; dy <= BANK_DEPTH; dy++) {
      for (let dx = 0; dx <= BANK_DEPTH; dx++) {
        if ((dx !== 0 || dy !== 0) && !at(x - dx, y - dy)) return true;
      }
    }
    return false;
  };
  return shape.map((row, y) => row.map((_, x) => inside[y]![x]! && groundUpLeft(x, y)));
}

const QUARTERS: {
  vertical: number;
  horizontal: number;
  corner: number;
  flipX: boolean;
  flipY: boolean;
}[] = [
  { vertical: N, horizontal: W, corner: NW, flipX: false, flipY: false },
  { vertical: N, horizontal: E, corner: NE, flipX: true, flipY: false },
  { vertical: S, horizontal: W, corner: SW, flipX: false, flipY: true },
  { vertical: S, horizontal: E, corner: SE, flipX: true, flipY: true },
];

function cornerKind(
  mask: number,
  quarter: (typeof QUARTERS)[number],
): keyof typeof ROUND_CORNER | null {
  const vertical = (mask & quarter.vertical) !== 0;
  const horizontal = (mask & quarter.horizontal) !== 0;
  if (!vertical && !horizontal) return "open";
  if (vertical && horizontal && !(mask & quarter.corner)) return "inner";
  return null;
}

function onShore(mask: number, x: number, y: number): boolean {
  return SHORE_DEPTH.every(({ side, depth, at }) => {
    if (mask & side) return true;
    const [along, from] = at(x, y);
    return from >= depth[along]!;
  });
}

function carveCorners(shape: boolean[][], mask: number, skipSouthernInner: boolean) {
  for (const quarter of QUARTERS) {
    const kind = cornerKind(mask, quarter);
    if (!kind || (kind === "inner" && quarter.flipY && skipSouthernInner)) continue;
    carveQuarter(shape, quarter, ROUND_CORNER[kind]);
  }
}

function carveQuarter(shape: boolean[][], quarter: (typeof QUARTERS)[number], stamp: string[]) {
  for (let qy = 0; qy < HALF; qy++) {
    for (let qx = 0; qx < HALF; qx++) {
      if (stamp[qy]![qx] === "#") continue;
      const x = quarter.flipX ? CELL - 1 - qx : qx;
      const y = quarter.flipY ? CELL - 1 - qy : qy;
      shape[y]![x] = false;
    }
  }
}

/**
 * The casting shape keeps the southern inner corners filled for the same reason
 * `nickCorners` skips them: ground at the near shore is lit, not casting.
 */
function roundShapes(mask: number): Shapes {
  const shore = (): boolean[][] =>
    Array.from({ length: CELL }, (_, y) =>
      Array.from({ length: CELL }, (_, x) => onShore(mask, x, y)),
    );
  const shape = shore();
  const casting = shore();
  carveCorners(shape, mask, false);
  carveCorners(casting, mask, true);
  return { shape, casting };
}

function floorShapes(mask: number, floors: PNG, cell: { x: number; y: number }): Shapes {
  const inside = Array.from({ length: CELL }, (_, y) =>
    Array.from({ length: CELL }, (_, x) => {
      const [r, g, b, a] = pixel(floors, (SHAPE_BLOCK_X + cell.x) * CELL + x, cell.y * CELL + y);
      return a > 0 && r === SHAPE_FILL[0] && g === SHAPE_FILL[1] && b === SHAPE_FILL[2];
    }),
  );
  return { shape: nickCorners(inside, mask), casting: nickCorners(inside, mask, true) };
}

const VARIANTS: Variant[] = [
  { tileId: "water", tilesetId: "water", name: "Water", shapes: floorShapes },
  {
    tileId: "water-round",
    tilesetId: "water-round",
    name: "Water (round)",
    shapes: roundShapes,
  },
];

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

type TilesetEntry = {
  id: string;
  name: string;
  file: string;
  width: number;
  height: number;
};

function paintCell(
  sheet: PNG,
  frame: number,
  row: number,
  shape: boolean[][],
  bank: boolean[][],
  lit: boolean[][],
  shade: boolean[][],
) {
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (!shape[y]![x]!) continue;
      const tone = bank[y]![x]! ? SHADOW : lit[y]![x]! ? HIGHLIGHT : shade[y]![x]! ? SHADOW : BASE;
      setPixel(sheet, frame * CELL + x, row * CELL + y, tone);
    }
  }
}

/**
 * A variant with no tile yet is created as a copy of the first variant's tile,
 * so it wades, slows and douses exactly like the water it is an alternative to.
 */
function pointTileAtSheet(
  tiles: TileDef[],
  variant: Variant,
  slices: number[],
  frameCount: number,
) {
  let tile = tiles.find((t) => t.id === variant.tileId);
  if (!tile) {
    const template = tiles.find((t) => t.id === VARIANTS[0]!.tileId);
    if (!template) throw new Error(`no ${VARIANTS[0]!.tileId} tile to copy`);
    tile = structuredClone(template);
    tile.id = variant.tileId;
    tile.name = variant.name;
    tiles.push(tile);
  }

  tile.type = "autotile";
  tile.anchor = { tilesetId: variant.tilesetId, x: 0, y: 0 };
  delete tile.sprite;
  tile.slices = Object.fromEntries(
    slices.map((slice, row): [number, TileSprite] => [
      slice,
      {
        frames: Array.from({ length: frameCount }, (_, frame) => ({
          sprite: {
            rect: { x: frame, y: row, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: FRAME_MS,
        })),
        phase: PHASE,
      },
    ]),
  );
}

function upsertTileset(sets: TilesetEntry[], variant: Variant, sheet: PNG) {
  const entry = {
    id: variant.tilesetId,
    name: variant.name,
    file: `${variant.tilesetId}.png`,
    width: sheet.width,
    height: sheet.height,
  };
  const existing = sets.find((s) => s.id === variant.tilesetId);
  if (existing) Object.assign(existing, entry);
  else sets.push(entry);
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

  const litByFrame: boolean[][][] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    litByFrame.push(
      Array.from({ length: CELL }, (_, y) =>
        Array.from({ length: CELL }, (_, x) => pixel(waves, frame * CELL + x, y)[3] > 0),
      ),
    );
  }
  const shadowByFrame = litByFrame.map((_, frame) => shadowOf(litByFrame, frame));

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = JSON.parse(await fs.readFile(tilesPath, "utf8")) as TileDef[];
  const setsPath = path.join(DATA, "tilesets.json");
  const sets = JSON.parse(await fs.readFile(setsPath, "utf8")) as TilesetEntry[];

  for (const variant of VARIANTS) {
    const sheet = new PNG({
      width: frameCount * CELL,
      height: slices.length * CELL,
    });
    sheet.data.fill(0);

    slices.forEach((slice, row) => {
      const { shape, casting } = variant.shapes(
        AUTOTILE_SLICE_MASKS[slice]!,
        floors,
        cells.get(slice)!,
      );
      const bank = bankOf(casting, shape);
      for (let frame = 0; frame < frameCount; frame++) {
        paintCell(sheet, frame, row, shape, bank, litByFrame[frame]!, shadowByFrame[frame]!);
      }
    });

    await fs.writeFile(path.join(TILESETS, `${variant.tilesetId}.png`), PNG.sync.write(sheet));
    pointTileAtSheet(tiles, variant, slices, frameCount);
    upsertTileset(sets, variant, sheet);

    console.log(
      `data/tilesets/${variant.tilesetId}.png — ${sheet.width}x${sheet.height}, ` +
        `${slices.length} slices x ${frameCount} frames`,
    );
  }

  await fs.writeFile(tilesPath, `${JSON.stringify(tiles, null, 2)}\n`);
  await fs.writeFile(setsPath, `${JSON.stringify(sets, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
