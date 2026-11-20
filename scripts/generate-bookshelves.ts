import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type Direction, type TileDef } from "../app/lib/types";
import type { Vec3 } from "./limb-caster";
import { castModel, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "bookshelves";

const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;
const PROJECTION = { spritePx: SPRITE_PX, groundPx: SPRITE_PX - CELL_SIZE, topPx: SPRITE_PX - 1 };

/** The shelf in whole pixels: `WIDTH` across its front, `DEPTH` from the front to the back panel, `HEIGHT` up. */
const WIDTH = CELL_SIZE;
const DEPTH = 3;
const HEIGHT = 7;

/** The boards across the shelf, by the height of their one-pixel layer. */
const BOARDS = [0, 3, 6];

/** Palette indices: the wood ramp of `table` and `chair`, which a bookshelf stands beside. */
const WOOD_TOP = 18;
const WOOD_FRONT = 13;
const WOOD_SIDE = 11;
const INSIDE = 3;
const INSIDE_BACK = 0;

/** `table` and `chair` are edged dark red along their top and left, and near-black along their bottom and right. */
const EDGE_LIT = 3;
const EDGE_SHADOW = 0;

/** A book's light and dark palette index: the light one is its spine, the dark one its shaded side. */
const RED = [10, 9] as const;
const BLUE = [24, 23] as const;
const GREEN = [16, 6] as const;
const PURPLE = [26, 7] as const;
const OCHRE = [19, 17] as const;
const BROWN = [13, 11] as const;
const TEAL = [30, 6] as const;
const PAPER = [27, 25] as const;

type Ramp = readonly [number, number];

/**
 * A box of one colour on a shelf, in the shelf's own pixels: `a` from the
 * left of its front as somebody facing it sees it, `d` back from its front,
 * `z` up from the floor.
 */
type Book = { a: [number, number]; d: [number, number]; z: [number, number]; ramp: Ramp };

/** Upright books along one shelf, one pixel wide each, standing on the board at `floor`. */
function row(floor: number, books: readonly (readonly [number, Ramp] | null)[]): Book[] {
  const out: Book[] = [];
  for (const [i, book] of books.entries()) {
    if (!book) continue;
    const [height, ramp] = book;
    const a = 1 + i;
    out.push({ a: [a, a + 1], d: [0, 2], z: [floor + 1, floor + 1 + height], ramp });
  }
  return out;
}

/** Books lying flat, bottom first, across `a`. */
function stack(floor: number, a: [number, number], ramps: readonly Ramp[]): Book[] {
  return ramps.map((ramp, i) => ({
    a,
    d: [0, 2],
    z: [floor + 1 + i, floor + 2 + i],
    ramp,
  }));
}

type Variant = { id: string; books: Book[] };

const LOW = BOARDS[0]!;
const HIGH = BOARDS[1]!;

const VARIANTS: Variant[] = [
  {
    id: "bookshelf",
    books: [
      ...row(LOW, [
        [2, RED],
        [2, OCHRE],
        [2, BLUE],
        [1, GREEN],
        [2, PURPLE],
        [2, BROWN],
      ]),
      ...row(HIGH, [
        [2, BLUE],
        [1, TEAL],
        [2, RED],
        [2, PAPER],
        [2, OCHRE],
        [1, GREEN],
      ]),
    ],
  },
  {
    id: "bookshelf-sparse",
    books: [
      ...row(LOW, [[2, PURPLE], [2, RED], null, null, null, [2, OCHRE]]),
      ...stack(LOW, [3, 6], [GREEN]),
      ...row(HIGH, [null, [2, BROWN], [2, BLUE], null, null, null]),
    ],
  },
  {
    id: "bookshelf-tomes",
    books: [
      ...stack(LOW, [1, 4], [BROWN, RED]),
      ...stack(LOW, [4, 7], [GREEN, BLUE]),
      ...stack(HIGH, [1, 3], [OCHRE, BROWN]),
      ...row(HIGH, [null, null, [2, RED], [2, TEAL], null, [2, PAPER]]),
    ],
  },
];

type Material = { kind: "wood" } | { kind: "book"; ramp: Ramp };

/** The shelf as voxels in its own coordinates, `[a][d][z]`. */
function build(variant: Variant): (Material | null)[][][] {
  const grid: (Material | null)[][][] = Array.from({ length: WIDTH }, () =>
    Array.from({ length: DEPTH }, () => Array<Material | null>(HEIGHT).fill(null)),
  );
  const wood: Material = { kind: "wood" };
  for (let a = 0; a < WIDTH; a++) {
    for (let d = 0; d < DEPTH; d++) {
      for (let z = 0; z < HEIGHT; z++) {
        const side = a === 0 || a === WIDTH - 1;
        const back = d === DEPTH - 1;
        if (side || back || BOARDS.includes(z)) grid[a]![d]![z] = wood;
      }
    }
  }
  for (const book of variant.books) {
    for (let a = book.a[0]; a < book.a[1]; a++) {
      for (let d = book.d[0]; d < book.d[1]; d++) {
        for (let z = book.z[0]; z < book.z[1]; z++) {
          grid[a]![d]![z] = { kind: "book", ramp: book.ramp };
        }
      }
    }
  }
  return grid;
}

/**
 * Where a voxel of the shelf stands in its cell, facing `facing`. The shelf
 * keeps its back to the edge of the cell behind it, where the wall it is set
 * against would be.
 */
function place(facing: Direction, a: number, d: number): [number, number] {
  if (facing === "s") return [a, DEPTH - 1 - d];
  if (facing === "n") return [CELL_SIZE - 1 - a, CELL_SIZE - DEPTH + d];
  if (facing === "e") return [DEPTH - 1 - d, CELL_SIZE - 1 - a];
  return [CELL_SIZE - DEPTH + d, a];
}

type Face = "top" | "south" | "east";
type Hit = { material: Material; face: Face; inside: "back" | "shelf" | null };

/** The shelf's voxels laid out in its cell, `[x][y][z]`, with which of them are the open inside of it. */
function lay(facing: Direction, grid: (Material | null)[][][]) {
  const world: (Material | null)[][][] = Array.from({ length: CELL_SIZE }, () =>
    Array.from({ length: CELL_SIZE }, () => Array<Material | null>(HEIGHT).fill(null)),
  );
  const hollow: boolean[][][] = Array.from({ length: CELL_SIZE }, () =>
    Array.from({ length: CELL_SIZE }, () => Array<boolean>(HEIGHT).fill(false)),
  );
  for (let a = 0; a < WIDTH; a++) {
    for (let d = 0; d < DEPTH; d++) {
      const [x, y] = place(facing, a, d);
      for (let z = 0; z < HEIGHT; z++) {
        world[x]![y]![z] = grid[a]![d]![z]!;
        hollow[x]![y]![z] = grid[a]![d]![z] === null;
      }
    }
  }
  const back = place(facing, 0, DEPTH - 1);
  const front = place(facing, 0, 0);
  const backAxis = back[0] !== front[0] ? 0 : 1;
  return { world, hollow, backAxis, backAt: back[backAxis] };
}

/**
 * A ray through the projection walks down and back, towards `-x`, `-y` and
 * `-z` at once, so the face it came in through is the one whose coordinate it
 * has only just crossed: the axis whose fraction is nearest 1.
 */
function sampler(facing: Direction, grid: (Material | null)[][][]) {
  const { world, hollow, backAxis, backAt } = lay(facing, grid);
  return (p: Vec3, scale: number): Hit | null => {
    const q = p.map((c) => c / scale) as Vec3;
    const [x, y, z] = q.map(Math.floor) as [number, number, number];
    if (x < 0 || y < 0 || z < 0 || x >= CELL_SIZE || y >= CELL_SIZE || z >= HEIGHT) return null;
    const material = world[x]![y]![z];
    if (!material) return null;
    const fx = q[0] - x;
    const fy = q[1] - y;
    const fz = q[2] - z;
    const face: Face = fz >= fx && fz >= fy ? "top" : fy >= fx ? "south" : "east";
    const [nx, ny, nz] =
      face === "top" ? [x, y, z + 1] : face === "south" ? [x, y + 1, z] : [x + 1, y, z];
    const open = nz < HEIGHT && nx < CELL_SIZE && ny < CELL_SIZE && hollow[nx]![ny]![nz]!;
    const onBack = material.kind === "wood" && [x, y][backAxis] === backAt;
    return { material, face, inside: open ? (onBack && face !== "top" ? "back" : "shelf") : null };
  };
}

/**
 * Lit from the south-west as every other block here: the top brightest, the
 * south face next and the east face dark. Wood that faces into the shelf is
 * in its shadow, and the back panel darkest of all.
 */
function shade(hit: Hit): number {
  if (hit.material.kind === "book") {
    const [light, dark] = hit.material.ramp;
    return hit.face === "east" ? dark : light;
  }
  if (hit.inside === "back") return INSIDE_BACK;
  if (hit.inside === "shelf") return INSIDE;
  if (hit.face === "top") return WOOD_TOP;
  if (hit.face === "south") return WOOD_FRONT;
  return WOOD_SIDE;
}

/**
 * Edges the cast the way `table` and `chair` are drawn: an empty pixel beside
 * the shelf takes the shadow colour where the shelf is to its left or above
 * it, and the lit edge where the shelf is to its right or below it.
 */
function edge(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const at = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size && pixels[v * size + u]! >= 0;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (at(u, v)) continue;
      if (at(u - 1, v) || at(u, v - 1)) out[v * size + u] = EDGE_SHADOW;
      else if (at(u + 1, v) || at(u, v + 1)) out[v * size + u] = EDGE_LIT;
    }
  }
  return out;
}

const FACINGS: Direction[] = ["n", "e", "s", "w"];

function facingSprite(column: number) {
  return {
    frames: [
      {
        sprite: {
          rect: { x: column * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
          base: { x: SPRITE_CELLS - 1, y: SPRITE_CELLS - 1 },
        },
        durationMs: 200,
      },
    ],
  };
}

/**
 * A bookshelf is a container nobody carries off, as a chest is, so a book
 * shelved in it is taken down and read from its card. Height 3 rather than
 * 4, because a prop of 4 makes the cell over it unwalkable and a bookshelf
 * stands under a roof.
 */
function tile(variant: Variant, row: number): TileDef {
  return {
    id: variant.id,
    name: "Bookshelf",
    height: 3,
    type: "directional",
    kind: "item",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS },
    lightPassing: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { item: { type: "container", size: 8, equippable: false } },
    sprites: Object.fromEntries(FACINGS.map((facing, column) => [facing, facingSprite(column)])),
  } as TileDef;
}

async function main() {
  const sheet = new PNG({
    width: FACINGS.length * SPRITE_PX,
    height: VARIANTS.length * SPRITE_PX,
  });
  sheet.data.fill(0);
  for (const [row, variant] of VARIANTS.entries()) {
    const grid = build(variant);
    for (const [column, facing] of FACINGS.entries()) {
      const model = { sample: sampler(facing, grid), shade };
      const pixels = edge(castModel(model, PROJECTION), SPRITE_PX);
      for (let i = 0; i < pixels.length; i++) {
        const x = column * SPRITE_PX + (i % SPRITE_PX);
        const y = row * SPRITE_PX + Math.floor(i / SPRITE_PX);
        if (pixels[i]! >= 0) paint(sheet, x, y, pixels[i]!);
      }
      /** `PREVIEW=<dir>` also writes each facing cast four times larger, to look at its shape before it is pixels. */
      if (process.env.PREVIEW) {
        const file = path.join(process.env.PREVIEW, `${variant.id}-${facing}-4x.png`);
        await writeCast(file, castModel(model, PROJECTION, 4), SPRITE_PX * 4);
      }
    }
  }
  await writeTileset(
    TILESET_ID,
    "Bookshelves",
    sheet,
    VARIANTS.map((variant, row) => tile(variant, row)),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
