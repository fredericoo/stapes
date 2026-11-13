import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef, type TileSprite } from "../app/lib/types";
import type { Vec3 } from "./limb-caster";
import { castModel, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET = "ice";
const FRAME_MS = 200;

const SNOW = 27;
const SNOW_BRIGHT = 28;
const SNOW_HOLLOW = 25;

const ICE = 30;
const ICE_GLINT = 29;
const ICE_CRACK = 24;
const ICE_RIM = 28;

const NEEDLE_RAMP = [15, 6, 6, 5];
const BARK_RAMP = [11, 11, 3, 3];
const ROCK_RAMP = [25, 22, 8, 4];
const SNOW_RAMP = [28, 28, 28, 25];

/** The props fill nine columns; the tenth is the ice, one slice to a row, which sets the sheet's height. */
const ICE_COLUMN = 9;
const SHEET_CELLS = { w: ICE_COLUMN + 1, h: AUTOTILE_SLICE_MASKS.length };
const SNOW_ROW = 0;
const PINE_ROW = 1;
const ROCK_ROW = 4;

/**
 * Every face keeps its border plain snow, and only its inner 6x6 carries a
 * dent. That is what lets the scatter put any face beside any other without a
 * seam, and `drawFace` refuses a face that breaks it.
 */
const SNOW_FACES: readonly (readonly string[])[] = [
  ["........", "........", "........", "........", "........", "........", "........", "........"],
  ["........", "........", "..dd....", ".d..d...", "........", "........", "........", "........"],
  ["........", "........", "........", "....dd..", "...dHHd.", "....dd..", "........", "........"],
  ["........", ".....d..", "....d...", "........", "..d.....", ".d......", "........", "........"],
  ["........", "........", "...ddd..", "..d.....", "........", "........", "....d.d.", "........"],
  ["........", "........", "........", "..d.....", "...dd...", ".....d..", "........", "........"],
];

/** The plain face is listed this many extra times, so most of the ground is smooth snow. */
const PLAIN_REPEATS = 30;

const SNOW_INK: Record<string, number> = { ".": SNOW, d: SNOW_BRIGHT, H: SNOW_HOLLOW };

function onBorder(x: number, y: number) {
  return x === 0 || y === 0 || x === CELL_SIZE - 1 || y === CELL_SIZE - 1;
}

function drawFace(sheet: PNG, grid: readonly string[], column: number) {
  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const key = grid[y]![x]!;
      const index = SNOW_INK[key];
      if (index === undefined) throw new Error(`no ink for '${key}'`);
      if (onBorder(x, y) && key !== ".") {
        throw new Error(`a snow face marks its border at (${x}, ${y}), so it would show a seam`);
      }
      paint(sheet, column * CELL_SIZE + x, SNOW_ROW * CELL_SIZE + y, index);
    }
  }
}

const LAST = CELL_SIZE - 1;

/**
 * The same marks in every slice, so a lake of any outline carries one
 * unbroken pattern: one glint and one crack.
 */
const ICE_FACE: readonly string[] = [
  "........",
  "......g.",
  ".....g..",
  "........",
  "........",
  "..c.....",
  "...c....",
  "........",
];

const ICE_INK: Record<string, number> = { ".": ICE, g: ICE_GLINT, c: ICE_CRACK };

/** How many pixels in from the nearest open side or open corner a pixel is. */
function depthFromOpenEdge(mask: number, x: number, y: number): number {
  let depth = Infinity;
  if (!(mask & N)) depth = Math.min(depth, y);
  if (!(mask & S)) depth = Math.min(depth, LAST - y);
  if (!(mask & W)) depth = Math.min(depth, x);
  if (!(mask & E)) depth = Math.min(depth, LAST - x);
  if (!(mask & NE)) depth = Math.min(depth, Math.max(LAST - x, y));
  if (!(mask & NW)) depth = Math.min(depth, Math.max(x, y));
  if (!(mask & SE)) depth = Math.min(depth, Math.max(LAST - x, LAST - y));
  if (!(mask & SW)) depth = Math.min(depth, Math.max(x, LAST - y));
  return depth;
}

/** A corner pixel with both of its sides open is left clear, which rounds the sheet's outline. */
function onOpenCorner(mask: number, x: number, y: number): boolean {
  const north = !(mask & N) && y === 0;
  const south = !(mask & S) && y === LAST;
  const west = !(mask & W) && x === 0;
  const east = !(mask & E) && x === LAST;
  return (north || south) && (west || east);
}

function drawIce(sheet: PNG) {
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        if (onOpenCorner(mask, x, y)) continue;
        const rim = depthFromOpenEdge(mask, x, y) === 0;
        paint(
          sheet,
          ICE_COLUMN * CELL_SIZE + x,
          slice * CELL_SIZE + y,
          rim ? ICE_RIM : ICE_INK[ICE_FACE[y]![x]!]!,
        );
      }
    }
  });
}

type Vec2 = [number, number];

/** A cone of boughs standing on `baseZ`, or with `tipRadiusPx` equal to `radiusPx`, a trunk. */
type Cone = { at: Vec2; baseZ: number; tipZ: number; radiusPx: number; tipRadiusPx: number };

type Boulder = { centre: Vec3; radii: Vec3 };

type Prop = { trunk?: Cone; tiers?: readonly Cone[]; boulders?: readonly Boulder[] };

type PropHit = { part: "bark" | "needles" | "rock"; normal: Vec3; up: number };

const MIDDLE = CELL_SIZE / 2;
const TIP_RADIUS_PX = 0.3;
const TRUNK: Cone = { at: [MIDDLE, MIDDLE], baseZ: 0, tipZ: 3, radiusPx: 1, tipRadiusPx: 1 };

/** One skirt of boughs. `lean` is how far the tree's top stands from its foot, shared out by height. */
function tier(baseZ: number, tipZ: number, radiusPx: number, lean: Vec2 = [0, 0]): Cone {
  const share = baseZ / 10;
  const at: Vec2 = [MIDDLE + lean[0] * share, MIDDLE + lean[1] * share];
  return { at, baseZ, tipZ, radiusPx, tipRadiusPx: TIP_RADIUS_PX };
}

/** Points are in pixels of the standing cell, `z` up; the cell's middle is 4, 4. */
const PINES: readonly Prop[] = [
  { trunk: TRUNK, tiers: [tier(2, 5.5, 4.3), tier(4.8, 8, 3.2), tier(7.4, 11, 2.2)] },
  { trunk: TRUNK, tiers: [tier(2, 5.5, 3.8), tier(5, 9, 2.6)] },
  {
    trunk: TRUNK,
    tiers: [
      tier(2, 5, 3.6, [1, -0.8]),
      tier(4.4, 7.4, 2.8, [1, -0.8]),
      tier(6.8, 10, 1.9, [1, -0.8]),
    ],
  },
];

const ROCKS: readonly Prop[] = [
  { boulders: [{ centre: [MIDDLE, MIDDLE, 1.2], radii: [3.3, 2.8, 2.6] }] },
  {
    boulders: [
      { centre: [3, 4.6, 0.8], radii: [2.5, 2.1, 2.2] },
      { centre: [6, 3, 0.4], radii: [1.7, 1.5, 1.4] },
    ],
  },
];

const PROP_CELLS = 3;
const PROP_PX = PROP_CELLS * CELL_SIZE;
const PROJECTION = {
  spritePx: PROP_PX,
  groundPx: PROP_PX - CELL_SIZE,
  topPx: PROP_PX - 2,
};

function sampleCone(cone: Cone, p: Vec3, part: PropHit["part"]): PropHit | null {
  if (p[2] < cone.baseZ || p[2] > cone.tipZ) return null;
  const rise = cone.tipZ - cone.baseZ;
  const up = (p[2] - cone.baseZ) / rise;
  const dx = p[0] - cone.at[0];
  const dy = p[1] - cone.at[1];
  const off = Math.hypot(dx, dy);
  if (off > cone.radiusPx + (cone.tipRadiusPx - cone.radiusPx) * up) return null;
  const taper = cone.radiusPx - cone.tipRadiusPx;
  const slant = Math.hypot(rise, taper);
  const outward = off === 0 ? 0 : rise / slant / off;
  return { part, up, normal: [dx * outward, dy * outward, taper / slant] };
}

function sampleBoulder(boulder: Boulder, p: Vec3): PropHit | null {
  const [a, b, c] = boulder.radii;
  const d: Vec3 = [
    (p[0] - boulder.centre[0]) / a,
    (p[1] - boulder.centre[1]) / b,
    (p[2] - boulder.centre[2]) / c,
  ];
  if (d[0] ** 2 + d[1] ** 2 + d[2] ** 2 > 1) return null;
  const normal: Vec3 = [d[0] / a, d[1] / b, d[2] / c];
  const length = Math.hypot(...normal);
  return {
    part: "rock",
    up: 0,
    normal: [normal[0] / length, normal[1] / length, normal[2] / length],
  };
}

function sampler(prop: Prop) {
  return (scaled: Vec3, scale: number): PropHit | null => {
    const p: Vec3 = [scaled[0] / scale, scaled[1] / scale, scaled[2] / scale];
    for (const cone of prop.tiers ?? []) {
      const hit = sampleCone(cone, p, "needles");
      if (hit) return hit;
    }
    for (const boulder of prop.boulders ?? []) {
      const hit = sampleBoulder(boulder, p);
      if (hit) return hit;
    }
    return prop.trunk ? sampleCone(prop.trunk, p, "bark") : null;
  };
}

/** Snow lies on the top of a tier of boughs from this share of its height up, and on rock that faces up more steeply than `SNOW_CAP_NORMAL`. */
const SNOW_FROM = 0.3;
const SNOW_CAP_NORMAL = 0.8;

const PART_RAMP: Record<PropHit["part"], readonly number[]> = {
  bark: BARK_RAMP,
  needles: NEEDLE_RAMP,
  rock: ROCK_RAMP,
};

/** Lit from the south-west, banded as the cacti and swamp trees are. */
function shadeProp({ part, normal, up }: PropHit): number {
  const across = (normal[0] - normal[1]) / Math.SQRT2;
  const snowy =
    (part === "needles" && up > SNOW_FROM) || (part === "rock" && normal[2] > SNOW_CAP_NORMAL);
  const ramp = snowy ? SNOW_RAMP : PART_RAMP[part];
  const band = Math.floor(((across + 1) / 2) * ramp.length);
  return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
}

function cellSprite(rect: { x: number; y: number; w: number; h: number }): TileSprite {
  return {
    frames: [{ sprite: { rect, base: { x: rect.w - 1, y: rect.h - 1 } }, durationMs: FRAME_MS }],
  };
}

function propFaces(count: number): TileSprite[] {
  return Array.from({ length: count }, (_, i) =>
    cellSprite({ x: i * PROP_CELLS, y: 0, w: PROP_CELLS, h: PROP_CELLS }),
  );
}

const SNOW_WALK_SPEED_PERCENT = -15;
const ICE_WALK_SPEED_PERCENT = 30;

function tiles(): TileDef[] {
  const snow: TileDef = {
    id: "snow",
    name: "Snow",
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: SNOW_ROW },
    walkSpeedPercent: SNOW_WALK_SPEED_PERCENT,
    scatter: [
      ...SNOW_FACES.map((_, i) => cellSprite({ x: i, y: 0, w: 1, h: 1 })),
      ...Array.from({ length: PLAIN_REPEATS }, () => cellSprite({ x: 0, y: 0, w: 1, h: 1 })),
    ],
  };
  const pine: TileDef = {
    id: "snowy-pine",
    name: "Snowy pine",
    height: HEIGHT_PER_LEVEL,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: PINE_ROW },
    walkable: false,
    lightPassing: true,
    scatter: propFaces(PINES.length),
  };
  const rock: TileDef = {
    id: "snowy-rock",
    name: "Snowy rock",
    height: 2,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: ROCK_ROW },
    walkable: false,
    lightPassing: true,
    scatter: propFaces(ROCKS.length),
  };
  const ice = {
    id: "ice",
    name: "Ice",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: ICE_COLUMN, y: 0 },
    lightPassing: true,
    walkSpeedPercent: ICE_WALK_SPEED_PERCENT,
    slices: Object.fromEntries(
      AUTOTILE_SLICE_MASKS.map((_, slice) => [
        slice,
        {
          frames: [
            {
              sprite: { rect: { x: 0, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } },
              durationMs: FRAME_MS,
            },
          ],
        },
      ]),
    ),
  } as TileDef;
  return [snow, pine, rock, ice];
}

async function castProps(sheet: PNG, props: readonly Prop[], row: number, name: string) {
  for (const [i, prop] of props.entries()) {
    const model = { sample: sampler(prop), shade: shadeProp };
    const pixels = castModel(model, PROJECTION);
    pixels.forEach((index, at) => {
      if (index < 0) return;
      paint(sheet, i * PROP_PX + (at % PROP_PX), row * CELL_SIZE + Math.floor(at / PROP_PX), index);
    });
    /** `PREVIEW=<dir>` also writes each face cast four times larger, to look at its shape before it is pixels. */
    if (process.env.PREVIEW) {
      const file = path.join(process.env.PREVIEW, `${name}-${i}-4x.png`);
      await writeCast(file, castModel(model, PROJECTION, 4), PROP_PX * 4);
    }
  }
}

async function main() {
  const sheet = new PNG({ width: SHEET_CELLS.w * CELL_SIZE, height: SHEET_CELLS.h * CELL_SIZE });
  /** pngjs leaves the buffer opaque black; the props need a transparent backdrop. */
  sheet.data.fill(0);
  SNOW_FACES.forEach((face, i) => drawFace(sheet, face, i));
  await castProps(sheet, PINES, PINE_ROW, "snowy-pine");
  await castProps(sheet, ROCKS, ROCK_ROW, "snowy-rock");

  drawIce(sheet);
  await writeTileset(TILESET, "Ice", sheet, tiles());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
