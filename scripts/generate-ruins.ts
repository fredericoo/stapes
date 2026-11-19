import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import type { Vec3 } from "./limb-caster";
import { castModel, outlineBelow, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "ruins";
const FRAME_MS = 200;

const CELL = CELL_SIZE;
const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL;
const PROJECTION = { spritePx: SPRITE_PX, groundPx: SPRITE_PX - CELL, topPx: SPRITE_PX - 1 };
const VARIANTS = 4;

/**
 * A half wall is four pixels high, so drapes stop there; anything longer would
 * hang past its foot onto the ground. Climbing ivy comes in the same short
 * height and a tall one for full walls and pillars.
 */
const MAX_DRAPE_PX = 4;
const SHORT_CLIMB: [number, number] = [2, 4];
const TALL_CLIMB: [number, number] = [5, 7];

/** Palette indices. */
const INK = 0;
const PLUM_DARK = 2;
const TEAL = 6;
const PLUM = 8;
const MOSS = 15;
const LEAF = 16;
const SPRING = 20;
const DUSK = 22;
const GREY = 25;

type Face = "top" | "south" | "east";

/**
 * Leaf tones are lit per face the way the walls are: the top and the south face
 * take the sun from the south-west, the east face is in shade.
 */
const FACE_TONES: Record<Face, Record<string, number>> = {
  top: { d: MOSS, m: LEAF, l: SPRING, s: PLUM },
  south: { d: TEAL, m: MOSS, l: LEAF, s: PLUM },
  east: { d: INK, m: TEAL, l: MOSS, s: PLUM_DARK },
};

/**
 * One face of a block seen square on, eight by eight. The top is seen from
 * above with north up. A side face has its first row at the top edge and its
 * last at the ground; the south face runs west to east, the east face north to
 * south.
 */
type Grid = string[][];
type Growth = Partial<Record<Face, Grid>>;

function emptyGrid(): Grid {
  return Array.from({ length: CELL }, () => Array<string>(CELL).fill("."));
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function set(grid: Grid, col: number, row: number, ch: string) {
  if (col < 0 || col >= CELL || row < 0 || row >= CELL) return;
  grid[row]![col] = ch;
}

/** A leaf: lit on its upper left, shaded underneath. */
function leaf(grid: Grid, col: number, row: number, random: () => number) {
  set(grid, col, row, "m");
  if (random() < 0.6) set(grid, col - 1, row, random() < 0.5 ? "l" : "m");
  if (random() < 0.5) set(grid, col, row + 1, "d");
  if (random() < 0.3) set(grid, col + 1, row, "d");
}

/**
 * Strands hanging from the top edge of a side face, with a lip of leaves on
 * the top face along that edge. `lip` places a leaf on the top face for a
 * column of the side face.
 */
function drape(face: Grid, top: Grid, lip: (col: number) => [number, number], seed: number) {
  const random = rng(seed);
  const strands = 4 + Math.floor(random() * 2);
  const used = new Set<number>();
  for (let i = 0; i < strands; i++) {
    let col = Math.floor(random() * CELL);
    while (used.has(col)) col = (col + 3) % CELL;
    used.add(col);
    const length = 1 + Math.floor(random() * MAX_DRAPE_PX);
    for (let row = 0; row < length; row++) {
      if (row % 2 === 0 || random() < 0.5) leaf(face, col, row, random);
      else set(face, col, row, "s");
    }
    const [tc, tr] = lip(col);
    leaf(top, tc, tr, random);
    if (random() < 0.5) set(top, tc + (random() < 0.5 ? 1 : -1), tr, "m");
  }
}

/** Stems climbing a side face from the ground, leaves alternating either side. */
function climb(face: Grid, seed: number, from: number, to: number) {
  const random = rng(seed);
  const stems = 3 + Math.floor(random() * 2);
  for (let i = 0; i < stems; i++) {
    let col = Math.floor(random() * CELL);
    const height = from + Math.floor(random() * (to - from + 1));
    for (let rise = 0; rise < height; rise++) {
      const row = CELL - 1 - rise;
      if (rise > 0 && random() < 0.3) col += random() < 0.5 ? -1 : 1;
      set(face, col, row, "s");
      if (random() < 0.7) leaf(face, col + (rise % 2 === 0 ? 1 : -1), row, random);
    }
    leaf(face, col, CELL - height, random);
  }
}

/** Tufts of moss and grass on a top face, kept off its edges so a round pillar top holds them. */
function tufts(top: Grid, seed: number) {
  const random = rng(seed);
  const count = 2 + Math.floor(random() * 2);
  for (let i = 0; i < count; i++) {
    const col = 2 + Math.floor(random() * 4);
    const row = 2 + Math.floor(random() * 4);
    set(top, col, row, "d");
    set(top, col + 1, row, random() < 0.5 ? "d" : "m");
    if (random() < 0.6) set(top, col, row - 1, "m");
    if (random() < 0.5) set(top, col - 1, row - 1, "l");
  }
}

/**
 * Where a face pixel lands in a two-cell sprite, given which sprite cell the
 * block's ground is in. A point `h` pixels up is drawn `h` up and `h` left, and
 * each face is eight pixels high.
 */
function facePixel(face: Face, col: number, row: number, ground: [number, number]) {
  const gx = ground[0] * CELL;
  const gy = ground[1] * CELL;
  if (face === "top") return [gx + col - CELL, gy + row - CELL] as const;
  const h = CELL - 1 - row;
  if (face === "south") return [gx + col - h, gy + CELL - 1 - h] as const;
  return [gx + CELL - 1 - h, gy + col - h] as const;
}

/**
 * How a family is placed. `on` stacks on top of the wall or pillar, so its
 * sprite is anchored on the top face and the block's ground is the south-east
 * cell. `north` and `west` stand in the cell south of, or east of, the block
 * they climb, so the block's ground is the north-east or south-west cell.
 */
type Placement = "on" | "north" | "west";

const BLOCK_GROUND: Record<Placement, [number, number]> = {
  on: [1, 1],
  north: [1, 0],
  west: [0, 1],
};

const SPRITE_BASE: Record<Placement, { x: number; y: number }> = {
  on: { x: 0, y: 0 },
  north: { x: 1, y: 1 },
  west: { x: 1, y: 1 },
};

type Family = {
  tileId: string;
  name: string;
  placement: Placement;
  grow: (seed: number) => Growth;
};

const southLip = (col: number): [number, number] => [col, CELL - 1];
const eastLip = (col: number): [number, number] => [CELL - 1, col];

const FAMILIES: Family[] = [
  {
    tileId: "vines-south",
    name: "Hanging vines (south face)",
    placement: "on",
    grow(seed) {
      const south = emptyGrid();
      const top = emptyGrid();
      drape(south, top, southLip, seed);
      return { south, top };
    },
  },
  {
    tileId: "vines-east",
    name: "Hanging vines (east face)",
    placement: "on",
    grow(seed) {
      const east = emptyGrid();
      const top = emptyGrid();
      drape(east, top, eastLip, seed);
      return { east, top };
    },
  },
  {
    tileId: "vines-corner",
    name: "Hanging vines (south-east corner)",
    placement: "on",
    grow(seed) {
      const south = emptyGrid();
      const east = emptyGrid();
      const top = emptyGrid();
      drape(south, top, southLip, seed);
      drape(east, top, eastLip, seed + 101);
      return { south, east, top };
    },
  },
  {
    tileId: "moss-top",
    name: "Moss (wall top)",
    placement: "on",
    grow(seed) {
      const top = emptyGrid();
      tufts(top, seed);
      return { top };
    },
  },
  {
    tileId: "ivy-north",
    name: "Climbing ivy (wall to the north)",
    placement: "north",
    grow(seed) {
      const south = emptyGrid();
      climb(south, seed, ...SHORT_CLIMB);
      return { south };
    },
  },
  {
    tileId: "ivy-west",
    name: "Climbing ivy (wall to the west)",
    placement: "west",
    grow(seed) {
      const east = emptyGrid();
      climb(east, seed, ...SHORT_CLIMB);
      return { east };
    },
  },
  {
    tileId: "ivy-tall-north",
    name: "Climbing ivy (tall, wall to the north)",
    placement: "north",
    grow(seed) {
      const south = emptyGrid();
      climb(south, seed, ...TALL_CLIMB);
      return { south };
    },
  },
  {
    tileId: "ivy-tall-west",
    name: "Climbing ivy (tall, wall to the west)",
    placement: "west",
    grow(seed) {
      const east = emptyGrid();
      climb(east, seed, ...TALL_CLIMB);
      return { east };
    },
  },
];

function paintGrowth(
  sheet: PNG,
  growth: Growth,
  origin: [number, number],
  ground: [number, number],
) {
  for (const face of ["top", "south", "east"] as const) {
    growth[face]?.forEach((line, row) =>
      line.forEach((ch, col) => {
        const index = FACE_TONES[face][ch];
        if (index === undefined) return;
        const [x, y] = facePixel(face, col, row, ground);
        if (x < 0 || y < 0 || x >= SPRITE_PX || y >= SPRITE_PX) return;
        paint(sheet, origin[0] + x, origin[1] + y, index);
      }),
    );
  }
}

/** A chunk of fallen stone: a box turned `yaw` radians about its own centre. */
type Chunk = { at: Vec3; half: Vec3; yaw: number; moss?: boolean };

type ChunkHit = { normal: Vec3; moss: boolean; across: number };

const RUBBLE: Chunk[][] = [
  [
    { at: [2.8, 3.2, 1.3], half: [2.4, 1.8, 1.3], yaw: 0.35 },
    { at: [5.6, 5.4, 1], half: [2, 1.6, 1], yaw: -0.5 },
    { at: [2.6, 6.3, 0.8], half: [1.6, 1.2, 0.8], yaw: 0.9, moss: true },
    { at: [4.4, 4, 2.8], half: [1.8, 1.3, 0.8], yaw: -0.2, moss: true },
    { at: [6.4, 1.8, 0.7], half: [1.2, 1, 0.7], yaw: 0.6 },
  ],
  [
    { at: [4.2, 3.2, 1.2], half: [2.8, 1.7, 1.2], yaw: -0.3, moss: true },
    { at: [2.2, 5.8, 0.9], half: [1.8, 1.3, 0.9], yaw: 0.7 },
    { at: [5.8, 6, 0.8], half: [1.5, 1.2, 0.8], yaw: 0.2 },
    { at: [1.6, 1.8, 0.6], half: [1.1, 1, 0.6], yaw: -0.8 },
    { at: [3.6, 4.6, 2.6], half: [1.2, 1, 0.6], yaw: 0.5 },
  ],
];

function chunkModel(chunks: Chunk[]) {
  return {
    sample([x, y, z]: Vec3, scale: number): ChunkHit | null {
      for (const chunk of chunks) {
        const dx = x / scale - chunk.at[0];
        const dy = y / scale - chunk.at[1];
        const dz = z / scale - chunk.at[2];
        const c = Math.cos(chunk.yaw);
        const s = Math.sin(chunk.yaw);
        const local: Vec3 = [c * dx + s * dy, -s * dx + c * dy, dz];
        const share = local.map((v, i) => Math.abs(v) / chunk.half[i]!);
        if (share.some((v) => v > 1)) continue;
        const axis = share.indexOf(Math.max(...share));
        const sign = Math.sign(local[axis]!) || 1;
        const n: Vec3 = [0, 0, 0];
        n[axis] = sign;
        const normal: Vec3 = [c * n[0] - s * n[1], s * n[0] + c * n[1], n[2]];
        return { normal, moss: !!chunk.moss, across: local[0]! / chunk.half[0]! };
      }
      return null;
    },
    shade({ normal, moss, across }: ChunkHit): number {
      if (normal[2] > 0.5) return moss && across < 0 ? MOSS : GREY;
      return normal[0] > normal[1] ? PLUM : DUSK;
    },
  };
}

function sprite(x: number, y: number, base: { x: number; y: number }): TileSprite {
  return {
    frames: [
      {
        sprite: { rect: { x, y, w: SPRITE_CELLS, h: SPRITE_CELLS }, base },
        durationMs: FRAME_MS,
      },
    ],
  };
}

async function main() {
  const rows = FAMILIES.length + 1;
  const sheet = new PNG({ width: VARIANTS * SPRITE_PX, height: rows * SPRITE_PX });
  sheet.data.fill(0);
  const tiles: TileDef[] = [];

  FAMILIES.forEach((family, row) => {
    for (let v = 0; v < VARIANTS; v++) {
      const growth = family.grow(row * 1000 + v * 17 + 1);
      paintGrowth(sheet, growth, [v * SPRITE_PX, row * SPRITE_PX], BLOCK_GROUND[family.placement]);
    }
    tiles.push({
      id: family.tileId,
      name: family.name,
      height: 0,
      type: "scatter",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS },
      lightPassing: true,
      intangible: true,
      scatter: Array.from({ length: VARIANTS }, (_, v) =>
        sprite(v * SPRITE_CELLS, 0, SPRITE_BASE[family.placement]),
      ),
    });
  });

  const rubbleRow = FAMILIES.length;
  for (const [i, chunks] of RUBBLE.entries()) {
    const model = chunkModel(chunks);
    const pixels = outlineBelow(castModel(model, PROJECTION), SPRITE_PX, PLUM_DARK);
    pixels.forEach((index, p) => {
      if (index < 0) return;
      paint(
        sheet,
        i * SPRITE_PX + (p % SPRITE_PX),
        rubbleRow * SPRITE_PX + Math.floor(p / SPRITE_PX),
        index,
      );
    });
    /** `PREVIEW=<dir>` also writes each pile cast four times larger, to judge its shape. */
    if (process.env.PREVIEW) {
      const file = path.join(process.env.PREVIEW, `rubble-${i}-4x.png`);
      await writeCast(file, castModel(model, PROJECTION, 4), SPRITE_PX * 4);
    }
  }
  tiles.push({
    id: "rubble",
    name: "Rubble",
    height: 1,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: rubbleRow * SPRITE_CELLS },
    walkable: true,
    scatter: RUBBLE.map((_, i) => sprite(i * SPRITE_CELLS, 0, { x: 1, y: 1 })),
  });

  await writeTileset(TILESET_ID, "Ruins", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
