import { PNG } from "pngjs";
import {
  CELL_SIZE,
  FULL_AUTOTILE_SLICE_COUNT,
  type TileDef,
  type TileSprite,
} from "../app/lib/types";
import { mulberry32 } from "./island/grid";
import {
  clearanceAt,
  joinedByMask,
  outlineCoverage,
  type Joined,
  type RoundedEdge,
} from "./rounded-edge";
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

/** 4 and 6 are the largest rounding that still leaves every cell's outline readable from its eight neighbours (`masksReadingTooFar`). */
const EDGE: RoundedEdge = { inset: 1.5, outerRound: 4, blend: 6 };

/** How far a lobe pushes the edge in or out, in art pixels. */
const LOBE_PX = 1;
/**
 * A lobe fades out over this many pixels towards every neighbour that is
 * grass too, so where the edge crosses into the next cell it is where the
 * outline alone puts it, whichever column either cell drew.
 */
const LOBE_FADE_PX = 3;
const WAVES = 3;

type Lobes = (px: number, py: number) => number;

/** A few sine waves at random angles and phases: lobes of uneven width rather than one bump repeated. */
function lobes(next: () => number): Lobes {
  const waves = Array.from({ length: WAVES }, () => {
    const angle = next() * Math.PI * 2;
    const period = 5 + next() * 6;
    return {
      kx: (Math.cos(angle) * Math.PI * 2) / period,
      ky: (Math.sin(angle) * Math.PI * 2) / period,
      phase: next() * Math.PI * 2,
    };
  });
  return (px, py) =>
    (LOBE_PX / WAVES) *
    waves.reduce((sum, w) => sum + Math.sin(w.kx * px + w.ky * py + w.phase), 0) *
    Math.SQRT2;
}

function distanceToCell(px: number, py: number, dx: number, dy: number): number {
  const gapX = Math.max(dx * CELL_SIZE - px, px - (dx + 1) * CELL_SIZE, 0);
  const gapY = Math.max(dy * CELL_SIZE - py, py - (dy + 1) * CELL_SIZE, 0);
  return Math.hypot(gapX, gapY);
}

function lobedOffset(joined: Joined, wave: Lobes): (px: number, py: number) => number {
  return (px, py) => {
    let fade = 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && joined(dx, dy)) {
          fade = Math.min(fade, distanceToCell(px, py, dx, dy) / LOBE_FADE_PX);
        }
      }
    }
    return wave(px, py) * fade;
  };
}

const next = mulberry32(PROFILE_SALT);
const LOBES: Lobes[] = Array.from({ length: COLUMNS }, () => lobes(next));

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

/**
 * Whether grass covers the pixel `x, y` of the centre cell, or of the row and
 * column just outside it. Outside the cell only the outline counts: the
 * neighbour's own lobes depend on its column, which this cell cannot know.
 */
function grassAt(joined: Joined, cover: number[][], x: number, y: number): boolean {
  if (x >= 0 && y >= 0 && x < CELL_SIZE && y < CELL_SIZE) return cover[y]![x]! >= 0.5;
  return clearanceAt(joined, EDGE, x + 0.5, y + 0.5) >= EDGE.inset;
}

/**
 * A pixel of grass with grass on at most one side is a spur, and a pixel of
 * ground with grass on three is a pit; both read as noise rather than an
 * edge. Only pixels clear of the cell's sides are tidied, since a side pixel's
 * neighbour across it is in a cell drawn from another column.
 */
function tidy(cover: number[][]): number[][] {
  const at = (x: number, y: number) => (cover[y]?.[x] ?? 0) >= 0.5;
  return cover.map((row, y) =>
    row.map((c, x) => {
      if (x === 0 || y === 0 || x === CELL_SIZE - 1 || y === CELL_SIZE - 1) return c;
      const around = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].filter(Boolean);
      if (at(x, y) && around.length <= 1) return 0;
      if (!at(x, y) && around.length >= 3) return 1;
      return c;
    }),
  );
}

function paintColumn(sheet: PNG, wave: Lobes, column: number) {
  for (let mask = 0; mask < FULL_AUTOTILE_SLICE_COUNT; mask++) {
    const joined = joinedByMask(mask);
    const cover = tidy(outlineCoverage(joined, EDGE, lobedOffset(joined, wave)));
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const at = [column * CELL_SIZE + x, mask * CELL_SIZE + y] as const;
        if (grassAt(joined, cover, x, y)) paint(sheet, ...at, GRASS);
        else if (grassAt(joined, cover, x - 1, y) || grassAt(joined, cover, x, y - 1)) {
          paintRgba(sheet, ...at, SHADOW);
        }
      }
    }
  }
}

/** Burning grass leaves the ground it lay on. */
const BURNS_AWAY = { endure: { durability: 12, suffers: [{ statusId: "burned", tileId: "" }] } };

function grassTile(): TileDef {
  const slices = Array.from({ length: FULL_AUTOTILE_SLICE_COUNT }, (_, mask): TileSprite => ({
    frames: [
      { sprite: { rect: { x: 0, y: mask, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
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
    autotileMask: "full",
    interactions: BURNS_AWAY,
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  } as TileDef;
}

if (import.meta.main) {
  const sheet = new PNG({
    width: COLUMNS * CELL_SIZE,
    height: FULL_AUTOTILE_SLICE_COUNT * CELL_SIZE,
  });
  sheet.data.fill(0);
  LOBES.forEach((wave, column) => paintColumn(sheet, wave, column));
  await writeTileset(TILESET_ID, "Grass", sheet, [grassTile()], { translucent: true });
}
