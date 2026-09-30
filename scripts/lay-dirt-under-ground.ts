import { parseMap, serializeMap } from "../app/lib/mapData";
import {
  normalizeTileDef,
  type FlatMapFile,
  type PlacedTile,
  type TileDef,
} from "../app/lib/types";
import { canReplaceStack, tilesByIdFromList } from "../app/lib/validation";

const DIRT = "dirt";
const GRASS = "grass-2";
const SURFACE_LEVEL = "0";
const SURFACE_FLOORS = new Set(["wooden-floor"]);

const mapPath = process.argv[2] ?? "data/map.json";
const TILES_PATH = "data/tiles.json";

/**
 * Grass used to be the ground and dirt a patch laid on it. Dirt is now the
 * ground and grass lies on it, so a patch becomes a cell grass left bare.
 */
function relaid(z: string, stack: PlacedTile[]): PlacedTile[] | null {
  const [bottom, next] = stack;
  if (bottom?.tileId === GRASS && next?.tileId === DIRT) return stack.slice(1);
  if (bottom?.tileId === GRASS) return [{ tileId: DIRT }, ...stack];
  if (z === SURFACE_LEVEL && bottom && SURFACE_FLOORS.has(bottom.tileId)) {
    return [{ tileId: DIRT }, ...stack];
  }
  return null;
}

const flat = JSON.parse(await Bun.file(mapPath).text()) as FlatMapFile;
const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map((raw) =>
  normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);

const changed: { z: string; key: string }[] = [];
for (const [z, cells] of Object.entries(flat.levels)) {
  for (const [key, stack] of Object.entries(cells)) {
    const next = relaid(z, stack);
    if (!next) continue;
    cells[key] = next;
    changed.push({ z, key });
  }
}

const map = parseMap(JSON.stringify(flat));
const refused: string[] = [];
for (const { z, key } of changed) {
  const [x, y] = key.split(",").map(Number) as [number, number];
  const check = canReplaceStack(map, x, y, Number(z), flat.levels[z]![key]!, tilesById);
  if (!check.ok) refused.push(`${key},${z}: ${check.reason}`);
}
if (refused.length) {
  console.error(`${refused.length} stacks no longer fit:\n${refused.slice(0, 20).join("\n")}`);
  process.exit(1);
}

await Bun.write(mapPath, serializeMap(map));
console.log(`${mapPath}: relaid ${changed.length} stacks`);
