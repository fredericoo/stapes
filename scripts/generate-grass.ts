import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { mulberry32 } from "./island/grid";
import { paint, paintRgba, writeTileset, type Rgba } from "./tileset-output";

const TILESET_ID = "grass";
const GRASS_ID = "grass";

/** `grass-2`'s own green, ragged where it stops. */
const GRASS = 15;

/**
 * The shadow grass casts on its south and east is black at this alpha, so it
 * darkens whatever the grass lies on. The sheet is translucent, and the palette
 * pass turns each darkened pixel into the palette colour nearest it: the
 * dunes' ripple colour over sand, the ice sheet's grey over snow.
 */
const SHADOW_ALPHA = 0.35;
const CHANNEL_MAX = 255;
const SHADOW: Rgba = [0, 0, 0, Math.round(SHADOW_ALPHA * CHANNEL_MAX)];

/**
 * Grass comes in this many columns, each with its own lobes on every side, and
 * the renderer picks one per cell from its position (`sliceColumns`). One
 * column alone repeats the same eight pixels of edge down every side.
 */
const COLUMNS = 6;
const PROFILE_SALT = 0x9e55;

type Profiles = { n: number[]; w: number[]; s: number[]; e: number[] };

/** How deep the cut is at both ends of every side, so a cell meets its neighbour's edge whichever variant either is. */
const END_CUT = 1;
const MAX_CUT = 2;
const HOLD_CHANCE = 0.3;

/**
 * How deep the cut into the grass is at each pixel along a side: a walk
 * that steps at most a pixel at a time between no cut and `MAX_CUT`, so the
 * edge is lobes of uneven width rather than one bump repeated.
 */
function profile(next: () => number): number[] {
  const cut = [END_CUT];
  for (let along = 1; along < CELL_SIZE - 1; along++) {
    const last = cut[along - 1]!;
    const flat = along > 1 && cut[along - 2] === last;
    const roll = next();
    /** A run held flat for two pixels always turns, so the edge is slopes and rounds, never a row of square teeth. */
    const step =
      !flat && roll < HOLD_CHANCE ? 0 : roll < HOLD_CHANCE + (1 - HOLD_CHANCE) / 2 ? -1 : 1;
    const bounced = last + step < 0 || last + step > MAX_CUT ? last - step : last + step;
    cut.push(bounced);
  }
  cut.push(END_CUT);
  return cut;
}

const next = mulberry32(PROFILE_SALT);
const CUTS: Profiles[] = Array.from({ length: COLUMNS }, () => ({
  n: profile(next),
  w: profile(next),
  s: profile(next),
  e: profile(next),
}));

/** Older grass that this grass runs into without an edge, as well as itself. */
const GRASS_GROUND = ["grass-2", "grass-brink", "grass-ledge"];

/**
 * Grass runs up to the foot of a cliff without an edge: the wall stands on
 * the hill's own ground, which is snow or sand under a frost or sandstone
 * wall, so an edge there would show a line of the grass's ground against it.
 */
const CLIFF_FEET = [
  "hill-wall",
  "hill-wall-frost",
  "hill-wall-sandstone",
  "hill-wall-basalt",
  "hill-cave-mouth",
  "hill-cave-mouth-frost",
  "hill-cave-mouth-sandstone",
  "hill-cave-mouth-basalt",
];

const LAST = CELL_SIZE - 1;

/** A south or east side is cut a pixel deeper, so the shadow its grass casts lands inside the cell rather than in the one beyond. */
const SHADED_SIDE_EXTRA_PX = 1;
/** How far into the cell a lone open corner's round notch reaches. */
const NOTCH_PX = 2;

/** Whether the grass covers a pixel, given the cell's open sides and corners. */
function grassAt(cut: Profiles, mask: number, x: number, y: number): boolean {
  const sides: Array<[open: boolean, depth: number, cutHere: number]> = [
    [!(mask & N), y, cut.n[x]!],
    [!(mask & W), x, cut.w[y]!],
    [!(mask & S), LAST - y, cut.s[x]! + SHADED_SIDE_EXTRA_PX],
    [!(mask & E), LAST - x, cut.e[y]! + SHADED_SIDE_EXTRA_PX],
  ];
  for (const [open, depth, cutHere] of sides) {
    if (open && depth < cutHere) return false;
  }
  const corners: Array<[open: boolean, dx: number, dy: number]> = [
    [!(mask & NW), x, y],
    [!(mask & NE), LAST - x, y],
    [!(mask & SW), x, LAST - y],
    [!(mask & SE), LAST - x, LAST - y],
  ];
  return !corners.some(([open, dx, dy]) => open && Math.hypot(dx, dy) < NOTCH_PX);
}

/** Whether a pixel is in the cut along an open south or east side, or in a lone south-east notch: the only ground the grass shades. */
function onShadedSide(cut: Profiles, mask: number, x: number, y: number): boolean {
  const south = !(mask & S) && LAST - y < cut.s[x]! + SHADED_SIDE_EXTRA_PX;
  const east = !(mask & E) && LAST - x < cut.e[y]! + SHADED_SIDE_EXTRA_PX;
  const notch = !(mask & SE) && Math.hypot(LAST - x, LAST - y) < NOTCH_PX;
  return south || east || notch;
}

/**
 * Grass to a pixel's west or north casts its shadow on it, so the shadow
 * falls along the south and east of the grass. Past the cell's own edge, a
 * side that joins more grass counts as grass.
 */
function shadowedAt(cut: Profiles, mask: number, x: number, y: number): boolean {
  if (!onShadedSide(cut, mask, x, y)) return false;
  const west = x > 0 ? grassAt(cut, mask, x - 1, y) : !!(mask & W);
  const north = y > 0 ? grassAt(cut, mask, x, y - 1) : !!(mask & N);
  return west || north;
}

function paintColumn(sheet: PNG, cut: Profiles, column: number) {
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const at = [column * CELL_SIZE + x, slice * CELL_SIZE + y] as const;
        if (grassAt(cut, mask, x, y)) paint(sheet, ...at, GRASS);
        else if (shadowedAt(cut, mask, x, y)) paintRgba(sheet, ...at, SHADOW);
      }
    }
  });
}

/** Burning grass leaves the ground it lay on. */
const BURNS_AWAY = { endure: { durability: 12, suffers: [{ statusId: "burned", tileId: "" }] } };

function grassTile(): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((_, slice): TileSprite => ({
    frames: [
      { sprite: { rect: { x: 0, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
    ],
  }));
  return {
    id: GRASS_ID,
    name: "Grass",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    lightPassing: true,
    connectsTo: [...GRASS_GROUND, ...CLIFF_FEET],
    sliceColumns: COLUMNS,
    interactions: BURNS_AWAY,
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  } as TileDef;
}

if (import.meta.main) {
  const sheet = new PNG({
    width: COLUMNS * CELL_SIZE,
    height: AUTOTILE_SLICE_MASKS.length * CELL_SIZE,
  });
  sheet.data.fill(0);
  CUTS.forEach((cut, column) => paintColumn(sheet, cut, column));
  await writeTileset(TILESET_ID, "Grass", sheet, [grassTile()], { translucent: true });
}
