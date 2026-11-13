import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { type Rgba, paintRgba, writeTileset } from "./tileset-output";

const TILESET_ID = "ledges";

const hex = (value: string): Rgba => {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};

type Ledge = { id: string; name: string; rim: Rgba; lip: Rgba; ground: string[] };

/** `ground` is what each ledge lies on, and so what it must read as more of itself. */
const LEDGES: Ledge[] = [
  {
    id: "grass-ledge",
    name: "Grass ledge",
    rim: hex("#165a4c"),
    lip: hex("#1ebc73"),
    ground: ["grass-2"],
  },
  {
    id: "sand-ledge",
    name: "Sand ledge",
    rim: hex("#cd683d"),
    lip: hex("#e6904e"),
    ground: ["sand-dunes"],
  },
  {
    id: "snow-ledge",
    name: "Snow ledge",
    rim: hex("#9babb2"),
    lip: hex("#ffffff"),
    ground: ["snow"],
  },
];

/** A bridge leaves a hilltop level with it, so the rim stops where the planks start. */
const BRIDGE_DECK = "wooden-floor";

const LAST = CELL_SIZE - 1;

/**
 * What the rim is at each pixel along an edge, one and two pixels in from it.
 * The same rows are used on every side and in every cell, so the tufts of two
 * neighbouring cells line up into one ragged line.
 */
const TUFTS: ReadonlyArray<ReadonlyArray<"rim" | "lip" | null>> = [
  ["rim", "lip", "lip", "rim", "rim", "lip", "rim", "lip"],
  ["lip", null, null, "lip", "rim", null, "lip", null],
];

/** How many pixels in from the nearest open side or open corner a pixel is, and how far along that side. */
function fromOpenEdge(mask: number, x: number, y: number): { depth: number; along: number } {
  let depth = Infinity;
  let along = 0;
  const consider = (d: number, a: number) => {
    if (d >= depth) return;
    depth = d;
    along = a;
  };
  if (!(mask & N)) consider(y, x);
  if (!(mask & S)) consider(LAST - y, x);
  if (!(mask & W)) consider(x, y);
  if (!(mask & E)) consider(LAST - x, y);
  if (!(mask & NE)) consider(Math.max(LAST - x, y), 0);
  if (!(mask & NW)) consider(Math.max(x, y), 0);
  if (!(mask & SE)) consider(Math.max(LAST - x, LAST - y), 0);
  if (!(mask & SW)) consider(Math.max(x, LAST - y), 0);
  return { depth, along };
}

function paintLedge(sheet: PNG, ledge: Ledge, column: number) {
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const { depth, along } = fromOpenEdge(mask, x, y);
        const at = [column * CELL_SIZE + x, slice * CELL_SIZE + y] as const;
        const tone = depth === 0 ? "rim" : (TUFTS[depth - 1]?.[along] ?? null);
        if (tone) paintRgba(sheet, ...at, ledge[tone]);
      }
    }
  });
}

function ledgeTile(ledge: Ledge, column: number): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((_, slice): TileSprite => ({
    frames: [
      { sprite: { rect: { x: 0, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
    ],
  }));
  return {
    id: ledge.id,
    name: ledge.name,
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: column, y: 0 },
    lightPassing: true,
    intangible: true,
    connectsTo: [
      ...ledge.ground,
      ...LEDGES.filter((other) => other !== ledge).map((o) => o.id),
      BRIDGE_DECK,
    ],
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  } as TileDef;
}

const sheet = new PNG({
  width: LEDGES.length * CELL_SIZE,
  height: AUTOTILE_SLICE_MASKS.length * CELL_SIZE,
});
sheet.data.fill(0);
LEDGES.forEach((ledge, column) => paintLedge(sheet, ledge, column));
await writeTileset(
  TILESET_ID,
  "Ledges",
  sheet,
  LEDGES.map((ledge, column) => ledgeTile(ledge, column)),
);
