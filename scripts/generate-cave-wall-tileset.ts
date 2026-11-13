import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import { STAPES_PALETTE } from "../app/lib/palette";
import {
  AUTOTILE_SLICE_COUNT,
  CELL_SIZE,
  HEIGHT_PER_LEVEL,
  type Direction,
  type TileDef,
  type TileSprite,
  type TilesetDef,
} from "../app/lib/types";
import { HILL_CROWN, type Point, footprint } from "./cave-wall-outline";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");

const TILESET_ID = "cave-wall";

const CELL = CELL_SIZE;
const HALF = CELL / 2;
const RISE = HEIGHT_PER_LEVEL * PX_PER_HEIGHT;

const SPRITE_CELLS = 2;
const SLICES_PER_ROW = 8;
const VARIANT_ROWS = Math.ceil(AUTOTILE_SLICE_COUNT / SLICES_PER_ROW) * SPRITE_CELLS;
const FRAME_MS = 200;

type Face = "top" | "south" | "bevel" | "east";

/** A speck `width` pixels wide covers `percent` of the positions it can start at. */
type Speck = { index: number; percent: number; width?: number };
type Ink = { base: number; specks: Speck[]; salt: number };
type Rock = Record<Face, Ink>;

/**
 * Palette indices of `half-stone`'s three faces, so the two can share a cave,
 * plus the entry between its south and east tones for a wall turning between them.
 */
const RED: Rock = {
  top: { base: 3, specks: [{ index: 11, percent: 12 }], salt: 1 },
  south: { base: 18, specks: [{ index: 11, percent: 16 }], salt: 2 },
  bevel: { base: 13, specks: [{ index: 11, percent: 14 }], salt: 4 },
  east: { base: 11, specks: [{ index: 3, percent: 12 }], salt: 3 },
};

/**
 * The palette's neutral dark grey on top and `stone-wall`'s greys on the sides,
 * each about as light as the red rock's same face, marked with streaks two
 * pixels wide a shade darker and single glints a shade lighter.
 */
const GREY: Rock = {
  top: {
    base: 1,
    specks: [
      { index: 8, percent: 7 },
      { index: 0, percent: 5 },
    ],
    salt: 5,
  },
  south: {
    base: 25,
    specks: [
      { index: 22, percent: 10, width: 2 },
      { index: 27, percent: 5 },
    ],
    salt: 6,
  },
  bevel: {
    base: 22,
    specks: [
      { index: 8, percent: 8, width: 2 },
      { index: 25, percent: 4 },
    ],
    salt: 7,
  },
  east: {
    base: 8,
    specks: [
      { index: 4, percent: 5, width: 2 },
      { index: 4, percent: 6 },
      { index: 22, percent: 3 },
    ],
    salt: 8,
  },
};

/**
 * Every variant shares one sheet, so a cave that mixes them costs no more draw
 * calls than a cave of one, and each connects to the others so the rock stays
 * whole where they meet. `crown` is how much wider than the plain outline the
 * rock is at the ceiling, and `spread` how much wider it is at the floor.
 */
type Variant = { tileId: string; name: string; crown: number; spread: number; rock: Rock };
const VARIANTS: Variant[] = [
  { tileId: "cave-wall", name: "Cave Wall", crown: 0, spread: 0, rock: RED },
  { tileId: "cave-wall-sloped", name: "Sloped Cave Wall", crown: 0, spread: HALF, rock: RED },
  { tileId: "cave-wall-grey", name: "Grey Cave Wall", crown: 0, spread: 0, rock: GREY },
  {
    tileId: "cave-wall-sloped-grey",
    name: "Grey Sloped Cave Wall",
    crown: 0,
    spread: HALF,
    rock: GREY,
  },
  { tileId: "hill-wall", name: "Hill Wall", crown: HILL_CROWN, spread: HALF, rock: RED },
];

const HILL = VARIANTS.find((variant) => variant.tileId === "hill-wall")!;

const MOUTH_ID = "hill-cave-mouth";
const MOUTH_WIDTH = CELL - 2;
const MOUTH_DARK = 0;

/**
 * A mouth is a cell of `hill-wall` in a straight cliff with a passage through
 * it. One sprite serves both ways a passage can face, so the rock slopes on
 * both of its ends: `ends` are the neighbours at each. The end inside the hill
 * is under the hilltop, where the slope is not seen.
 */
const MOUTHS: { facings: readonly Direction[]; ends: readonly [number, number] }[] = [
  { facings: ["n", "s"], ends: [N | NE | NW, S | SE | SW] },
  { facings: ["e", "w"], ends: [E | NE | SE, W | NW | SW] },
];

/** How high the passage is over each pixel of its width: an arch, two pixels under the wall's top at its crown. */
function mouthRoof(across: number): number {
  const fromMiddle = Math.abs(across + 0.5 - HALF);
  if (fromMiddle >= MOUTH_WIDTH / 2) return 0;
  return fromMiddle < MOUTH_WIDTH / 2 - 1 ? RISE - 2 : RISE - 3;
}

const NORMAL_REACH = 2;

/**
 * The rock in each pixel of height, floor first: the outline widened by `crown`
 * at the ceiling and by `spread` at the floor, in a straight line between, so
 * the sides slope out evenly. A ridge takes no part of `crown`: with a wider
 * top, its side then stands where the face of thicker rock beside it stands,
 * at every height, so rock one cell thick lines up with the cliff it joins.
 */
function crossSections(mask: number, crown: number, spread: number): boolean[][][] {
  return Array.from({ length: RISE }, (_, layer) => {
    const down = (RISE - 1 - layer) / (RISE - 1);
    return footprint(mask, crown + (spread - crown) * down, (spread * down) / 2);
  });
}

/**
 * Walks the view ray through sprite pixel `sx, sy` down from the top of the wall,
 * which is footprint pixel `sx, sy`: the wall rises the one cell the sprite's base
 * is offset by. The ray crosses the grid only at pixel corners, so it is nudged
 * east of each, and a hit on the pixel beside the diagonal is a south face. Below
 * the top, a pixel met from above is the tread of a slope.
 */
function hitAt(
  layers: boolean[][][],
  sx: number,
  sy: number,
  hollow?: (layer: number, x: number, y: number) => boolean,
): (Point & { layer: number; face: Face | "hollow" }) | null {
  const rock = (layer: number, x: number, y: number) =>
    x >= 0 && y >= 0 && x < CELL && y < CELL && layers[layer]![y]![x]!;
  const inside = (layer: number, x: number, y: number) =>
    x >= 0 && y >= 0 && x < CELL && y < CELL && hollow?.(layer, x, y) === true;
  let through = false;
  for (let layer = RISE - 1; layer >= 0; layer--) {
    const x = sx - (RISE - 1 - layer);
    const y = sy - (RISE - 1 - layer);
    if (through && (x < 0 || y < 0)) return { x, y, layer, face: "hollow" };
    for (const [px, py, face] of [
      [x, y, layer === RISE - 1 ? "top" : "south"],
      [x, y - 1, "south"],
      [x - 1, y - 1, "east"],
    ] as const) {
      if (inside(layer, px, py)) through = true;
      else if (rock(layer, px, py)) return { x: px, y: py, layer, face: through ? "hollow" : face };
    }
  }
  return null;
}

/**
 * Shades a side by the way the rock falls away around the footprint pixel it was
 * hit on, rather than by the single step the ray met, which alternates along a
 * curve and draws a checkerboard. It reads the height of the rock rather than one
 * layer's outline, so a slope that has reached the cell's edge still has a
 * direction. Past the edge the edge pixel is read again, since every outline
 * crosses it square on.
 */
function sideFace(heights: number[][], x: number, y: number, step: Face): Face {
  let nx = 0;
  let ny = 0;
  for (let dy = -NORMAL_REACH; dy <= NORMAL_REACH; dy++) {
    for (let dx = -NORMAL_REACH; dx <= NORMAL_REACH; dx++) {
      const col = Math.min(CELL - 1, Math.max(0, x + dx));
      const row = Math.min(CELL - 1, Math.max(0, y + dy));
      nx -= heights[row]![col]! * dx;
      ny -= heights[row]![col]! * dy;
    }
  }
  if (nx === 0 && ny === 0) return step;
  const angle = Math.atan2(ny, nx);
  if (angle > (3 * Math.PI) / 8) return "south";
  if (angle < Math.PI / 8) return "east";
  return "bevel";
}

/**
 * Keyed on the screen pixel modulo a cell, so every slice agrees on where the
 * specks fall and a face that runs across several cells has no seam. A speck
 * two pixels wide hashes the pair it covers, and a cell's width holds whole pairs.
 */
function inkAt(sx: number, sy: number, ink: Ink): number {
  for (const [i, { index, percent, width = 1 }] of ink.specks.entries()) {
    let h =
      Math.imul(Math.floor((sx % CELL) / width) + 1, 0x27d4eb2d) ^
      Math.imul((sy % CELL) + 1, 0x165667b1) ^
      Math.imul(ink.salt + 16 * i, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    if ((h >>> 0) % 100 < percent) return index;
  }
  return ink.base;
}

function rgba(index: number): [number, number, number, number] {
  const hex = STAPES_PALETTE[index];
  if (!hex) throw new Error(`no palette entry ${index}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

/**
 * Casts `layers` into the sprite at the origin. Rock seen through a `hollow`
 * pixel is dark, and so is a ray that leaves the cell inside the passage; one
 * that reaches the floor first is left clear, so the floor under the tile shows.
 */
function cast(
  sheet: PNG,
  originX: number,
  originY: number,
  layers: boolean[][][],
  heights: number[][],
  rock: Rock,
  hollow?: (layer: number, x: number, y: number) => boolean,
) {
  const size = SPRITE_CELLS * CELL;
  for (let sy = 0; sy < size; sy++) {
    for (let sx = 0; sx < size; sx++) {
      const hit = hitAt(layers, sx, sy, hollow);
      if (!hit) continue;
      const index =
        hit.face === "hollow"
          ? MOUTH_DARK
          : inkAt(
              sx,
              sy,
              rock[hit.face === "top" ? "top" : sideFace(heights, hit.x, hit.y, hit.face)],
            );
      const colour = rgba(index);
      const i = (sheet.width * (originY + sy) + originX + sx) << 2;
      for (let c = 0; c < 4; c++) sheet.data[i + c] = colour[c]!;
    }
  }
}

const heightsOf = (layers: boolean[][][]) =>
  layers[0]!.map((row, y) => row.map((_, x) => layers.filter((layer) => layer[y]![x]).length));

function drawSlice(
  sheet: PNG,
  originX: number,
  originY: number,
  mask: number,
  { crown, spread, rock }: Variant,
) {
  const layers = crossSections(mask, crown, spread);
  cast(sheet, originX, originY, layers, heightsOf(layers), rock);
}

/**
 * The passage is taken out of the rock and cast with it, so the opening is
 * sheared with the face it is in, as a door is. The sides are shaded from the
 * wall before it was cut, so the face round the opening is the face of the
 * cells beside it.
 */
function drawMouth(sheet: PNG, originX: number, originY: number, mouth: (typeof MOUTHS)[number]) {
  const [near, far] = mouth.ends.map((open) =>
    crossSections(~open & 0xff, HILL.crown, HILL.spread),
  ) as [boolean[][][], boolean[][][]];
  const whole = near.map((rows, layer) =>
    rows.map((row, y) => row.map((rock, x) => rock && far[layer]![y]![x]!)),
  );
  const alongY = mouth.facings.includes("s");
  const hollow = (layer: number, x: number, y: number) =>
    whole[layer]![y]![x]! && layer < mouthRoof(alongY ? x : y);
  const layers = whole.map((rows, layer) =>
    rows.map((row, y) => row.map((rock, x) => rock && !hollow(layer, x, y))),
  );
  /**
   * A ray counts as inside the passage only once it has met the near half of
   * it. One that comes over the hilltop and drops into the far end would
   * otherwise draw a dark sliver above the brink there.
   */
  const seen = (layer: number, x: number, y: number) =>
    hollow(layer, x, y) && (alongY ? y : x) >= HALF;
  cast(sheet, originX, originY, layers, heightsOf(whole), HILL.rock, seen);
}

function sliceRect(slice: number) {
  return {
    x: (slice % SLICES_PER_ROW) * SPRITE_CELLS,
    y: Math.floor(slice / SLICES_PER_ROW) * SPRITE_CELLS,
    w: SPRITE_CELLS,
    h: SPRITE_CELLS,
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const sheet = new PNG({
    width: SLICES_PER_ROW * SPRITE_CELLS * CELL,
    height: (VARIANTS.length * VARIANT_ROWS + SPRITE_CELLS) * CELL,
  });
  sheet.data.fill(0);

  const tilesPath = path.join(DATA, "tiles.json");
  const tiles = await readJson<TileDef[]>(tilesPath);
  VARIANTS.forEach((variant, v) => {
    const { tileId, name } = variant;
    const anchor = { tilesetId: TILESET_ID, x: 0, y: v * VARIANT_ROWS };
    const slices: Record<number, TileSprite> = {};
    for (let slice = 0; slice < AUTOTILE_SLICE_COUNT; slice++) {
      const rect = sliceRect(slice);
      const mask = AUTOTILE_SLICE_MASKS[slice]!;
      drawSlice(sheet, rect.x * CELL, (anchor.y + rect.y) * CELL, mask, variant);
      slices[slice] = {
        frames: [{ sprite: { rect, base: { x: 1, y: 1 } }, durationMs: FRAME_MS }],
      };
    }
    const others = [
      ...VARIANTS.filter((other) => other.tileId !== tileId).map((o) => o.tileId),
      MOUTH_ID,
    ];
    const existing = tiles.find((t) => t.id === tileId);
    if (existing) {
      delete existing.sprite;
      const connectsTo = [...new Set([...(existing.connectsTo ?? []), ...others])];
      Object.assign(existing, {
        type: "autotile",
        anchor,
        connectsTo,
        slices,
      } satisfies Partial<TileDef>);
    } else {
      tiles.push({
        id: tileId,
        name,
        height: 4,
        type: "autotile",
        kind: "prop",
        attributes: {},
        anchor,
        walkable: false,
        connectsTo: ["stone-wall", "half-stone", ...others],
        slices,
      });
    }
  });
  const mouthAnchor = { tilesetId: TILESET_ID, x: 0, y: VARIANTS.length * VARIANT_ROWS };
  const sprites: Partial<Record<Direction, TileSprite>> = {};
  MOUTHS.forEach((mouth, i) => {
    const rect = { x: i * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS };
    drawMouth(sheet, rect.x * CELL, mouthAnchor.y * CELL, mouth);
    for (const facing of mouth.facings) {
      sprites[facing] = {
        frames: [{ sprite: { rect, base: { x: 1, y: 1 } }, durationMs: FRAME_MS }],
      };
    }
  });
  const mouthTile = tiles.find((t) => t.id === MOUTH_ID);
  if (mouthTile) {
    Object.assign(mouthTile, { type: "directional", anchor: mouthAnchor, sprites });
  } else {
    tiles.push({
      id: MOUTH_ID,
      name: "Hill Cave Mouth",
      height: 4,
      type: "directional",
      kind: "prop",
      attributes: {},
      anchor: mouthAnchor,
      lightPassing: true,
      intangible: true,
      walkable: false,
      sprites,
    } as TileDef);
  }
  await fs.writeFile(path.join(DATA, "tilesets", `${TILESET_ID}.png`), PNG.sync.write(sheet));
  await writeJson(tilesPath, tiles);

  const setsPath = path.join(DATA, "tilesets.json");
  const sets = await readJson<TilesetDef[]>(setsPath);
  const entry: TilesetDef = {
    id: TILESET_ID,
    name: "Cave Wall",
    file: `${TILESET_ID}.png`,
    width: sheet.width,
    height: sheet.height,
  };
  const set = sets.find((s) => s.id === TILESET_ID);
  if (set) Object.assign(set, entry);
  else sets.push(entry);
  await writeJson(setsPath, sets);

  console.log(
    `data/tilesets/${TILESET_ID}.png — ${sheet.width}x${sheet.height}, ` +
      `${VARIANTS.length} variants of ${AUTOTILE_SLICE_COUNT} slices`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
