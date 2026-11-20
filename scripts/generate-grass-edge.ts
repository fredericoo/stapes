import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { mulberry32 } from "./island/grid";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "grass-edge";

/** `grass-2`'s own green: the edge is the same grass, only ragged. */
const GRASS = 15;

/**
 * One edge per ground it lies on, as the shadow it casts is that ground's
 * own darker shade: the dunes' ripple colour on sand, the grey of the ice
 * sheet's cracks on snow. A translucent shadow would serve both, but a
 * translucent sheet is drawn after the level and would cover what stands on
 * the cell.
 */
const GROUNDS = [
  { id: "grass-edge-sand", name: "Grass edge (sand)", shadow: 18 },
  { id: "grass-edge-snow", name: "Grass edge (snow)", shadow: 25 },
] as const;

/**
 * Each ground's edge comes in this many tiles, each with its own lobes on
 * every side, and `generate:island` picks one per cell from its position.
 * An autotile draws one sprite per slice, so one tile alone repeats the same
 * eight pixels of edge down every side.
 */
export const GRASS_EDGE_VARIANTS = 6;
const PROFILE_SALT = 0x9e55;

type Profiles = { n: number[]; w: number[]; s: number[]; e: number[] };
type Edge = { id: string; name: string; shadow: number; cut: Profiles };

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

const EDGES: Edge[] = GROUNDS.flatMap((g) => {
  const next = mulberry32(PROFILE_SALT);
  return Array.from({ length: GRASS_EDGE_VARIANTS }, (_, v) => ({
    id: `${g.id}-${v}`,
    name: `${g.name} ${v + 1}`,
    shadow: g.shadow,
    cut: { n: profile(next), w: profile(next), s: profile(next), e: profile(next) },
  }));
});

/**
 * The grounds a grass edge lies beside without drawing an edge: everything
 * whose top is grass. The ground the edge is laid on (sand, snow) is not
 * here, so the edge is drawn towards it.
 */
const GRASS_GROUND = ["grass-2", "grass-brink", "grass-ledge"];

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

function paintEdge(sheet: PNG, { cut, shadow }: Edge, column: number) {
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const at = [column * CELL_SIZE + x, slice * CELL_SIZE + y] as const;
        if (grassAt(cut, mask, x, y)) paint(sheet, ...at, GRASS);
        else if (shadowedAt(cut, mask, x, y)) paint(sheet, ...at, shadow);
      }
    }
  });
}

function edgeTile(id: string, name: string, column: number): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((_, slice): TileSprite => ({
    frames: [
      { sprite: { rect: { x: 0, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
    ],
  }));
  return {
    id,
    name,
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: column, y: 0 },
    lightPassing: true,
    connectsTo: [...GRASS_GROUND, ...EDGES.map((e) => e.id).filter((e) => e !== id)],
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  } as TileDef;
}

if (import.meta.main) {
  const sheet = new PNG({
    width: EDGES.length * CELL_SIZE,
    height: AUTOTILE_SLICE_MASKS.length * CELL_SIZE,
  });
  sheet.data.fill(0);
  EDGES.forEach((e, column) => paintEdge(sheet, e, column));
  await writeTileset(
    TILESET_ID,
    "Grass edge",
    sheet,
    EDGES.map((e, column) => edgeTile(e.id, e.name, column)),
  );
}
