import path from "node:path";
import { promises as fs } from "node:fs";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS } from "../app/lib/autotile";
import { CELL_SIZE, type TileDef, type TileSprite, type TilesetDef } from "../app/lib/types";
import { HILL_CROWN, footprint } from "./cave-wall-outline";
import { type Rgba, paintRgba, readJson, writeTileset } from "./tileset-output";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const TILESET_ID = "brinks";

const hex = (value: string): Rgba => {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};

type Brink = { id: string; name: string; ground: string; rim: Rgba; lip: Rgba };

/** `ground` is the tile each brink is cut from. The rim colours are the ones its ledge in `generate-ledges.ts` has. */
const BRINKS: Brink[] = [
  {
    id: "grass-brink",
    name: "Grass brink",
    ground: "grass-2",
    rim: hex("#165a4c"),
    lip: hex("#1ebc73"),
  },
  {
    id: "sand-brink",
    name: "Sand brink",
    ground: "sand-dunes",
    rim: hex("#cd683d"),
    lip: hex("#e6904e"),
  },
];

/** The same rows `generate-ledges.ts` draws, so a brink beside a ledge carries on its tufts. */
const TUFTS: ReadonlyArray<ReadonlyArray<"rim" | "lip" | null>> = [
  ["rim", "lip", "lip", "rim", "rim", "lip", "rim", "lip"],
  ["lip", null, null, "lip", "rim", null, "lip", null],
];

const REACH = TUFTS.length;
const STEPS = [
  { dx: 0, dy: -1, along: "x" },
  { dx: 0, dy: 1, along: "x" },
  { dx: -1, dy: 0, along: "y" },
  { dx: 1, dy: 0, along: "y" },
] as const;

/**
 * How many pixels of ground lie between a pixel and the nearest open one in a
 * straight line, and how far along that edge it is. Past the cell's edge the
 * edge pixel is read again: every outline crosses an edge square on, so the
 * neighbouring slice carries on what this one has there.
 */
function fromOpenEdge(covered: boolean[][], x: number, y: number) {
  const at = (px: number, py: number) =>
    covered[Math.min(CELL_SIZE - 1, Math.max(0, py))]![Math.min(CELL_SIZE - 1, Math.max(0, px))]!;
  for (let depth = 0; depth <= REACH; depth++) {
    for (const { dx, dy, along } of STEPS) {
      if (!at(x + dx * (depth + 1), y + dy * (depth + 1))) {
        return { depth, along: along === "x" ? x : y };
      }
    }
  }
  return null;
}

async function groundPixels(ground: string): Promise<Rgba[][]> {
  const tiles = await readJson<TileDef[]>(path.join(DATA, "tiles.json"));
  const sets = await readJson<TilesetDef[]>(path.join(DATA, "tilesets.json"));
  const tile = tiles.find((t) => t.id === ground);
  const sprite = tile?.sprite ?? tile?.scatter?.[0];
  const rect = sprite?.frames[0]?.sprite.rect;
  const set = sets.find((s) => s.id === tile?.anchor.tilesetId);
  if (!tile || !rect || !set) throw new Error(`no sprite for ${ground}`);
  const sheet = PNG.sync.read(await fs.readFile(path.join(DATA, "tilesets", set.file)));
  const x0 = (tile.anchor.x + rect.x) * CELL_SIZE;
  const y0 = (tile.anchor.y + rect.y) * CELL_SIZE;
  return Array.from({ length: CELL_SIZE }, (_, y) =>
    Array.from({ length: CELL_SIZE }, (_, x): Rgba => {
      const i = (sheet.width * (y0 + y) + x0 + x) << 2;
      return [sheet.data[i]!, sheet.data[i + 1]!, sheet.data[i + 2]!, sheet.data[i + 3]!];
    }),
  );
}

/**
 * Each slice is the ground cut to the outline `hill-wall` has at its ceiling
 * for the same neighbours, so a brink on the level above a wall covers the
 * wall's top exactly and nothing else.
 */
function paintBrink(sheet: PNG, brink: Brink, ground: Rgba[][], column: number) {
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    const covered = footprint(mask, HILL_CROWN);
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        if (!covered[y]![x]) continue;
        const edge = fromOpenEdge(covered, x, y);
        const tone = !edge ? null : edge.depth === 0 ? "rim" : TUFTS[edge.depth - 1]![edge.along];
        const at = [column * CELL_SIZE + x, slice * CELL_SIZE + y] as const;
        paintRgba(sheet, ...at, tone ? brink[tone] : ground[y]![x]!);
      }
    }
  });
}

function brinkTile(brink: Brink, column: number): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((_, slice): TileSprite => ({
    frames: [
      { sprite: { rect: { x: 0, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
    ],
  }));
  return {
    id: brink.id,
    name: brink.name,
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: column, y: 0 },
    lightPassing: true,
    connectsTo: BRINKS.flatMap((other) =>
      other === brink ? [other.ground] : [other.ground, other.id],
    ),
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  } as TileDef;
}

const sheet = new PNG({
  width: BRINKS.length * CELL_SIZE,
  height: AUTOTILE_SLICE_MASKS.length * CELL_SIZE,
});
sheet.data.fill(0);
for (const [column, brink] of BRINKS.entries()) {
  paintBrink(sheet, brink, await groundPixels(brink.ground), column);
}
await writeTileset(
  TILESET_ID,
  "Brinks",
  sheet,
  BRINKS.map((brink, column) => brinkTile(brink, column)),
);
