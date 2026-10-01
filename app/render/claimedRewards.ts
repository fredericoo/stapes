import { resolveRewardDef } from "../lib/interactions";
import type { ChunkCells, LevelChunks, MapFile, PlacedTile, TileDef } from "../lib/types";

type DrawnChunk = { tagsKey: string; drawn: ChunkCells };

const drawnByCatalogue = new WeakMap<Record<string, TileDef>, WeakMap<ChunkCells, DrawnChunk>>();

function drawnChunksFor(tilesById: Record<string, TileDef>): WeakMap<ChunkCells, DrawnChunk> {
  let chunks = drawnByCatalogue.get(tilesById);
  if (!chunks) {
    chunks = new WeakMap();
    drawnByCatalogue.set(tilesById, chunks);
  }
  return chunks;
}

/**
 * Draws a reward placement the viewer has already taken as its `claimedTileId`.
 * Only the renderer sees the swap; the rules keep the real tile. An untouched chunk
 * is returned as itself, because `diffMapChunks` rebuilds every chunk whose identity
 * changed.
 */
export function withClaimedRewards(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  tags: readonly string[],
): MapFile {
  if (tags.length === 0) return map;
  const tagsKey = tags.join("\n");
  let levels: Record<string, LevelChunks> | null = null;
  for (const [z, level] of Object.entries(map.levels)) {
    const drawn = drawnLevel(level, tilesById, tags, tagsKey);
    if (drawn === level) continue;
    levels ??= { ...map.levels };
    levels[z] = drawn;
  }
  return levels ? { ...map, levels } : map;
}

function drawnLevel(
  level: LevelChunks,
  tilesById: Record<string, TileDef>,
  tags: readonly string[],
  tagsKey: string,
): LevelChunks {
  let chunks: LevelChunks | null = null;
  for (const [key, chunk] of Object.entries(level)) {
    const drawn = drawnChunk(chunk, tilesById, tags, tagsKey);
    if (drawn === chunk) continue;
    chunks ??= { ...level };
    chunks[key] = drawn;
  }
  return chunks ?? level;
}

function drawnChunk(
  chunk: ChunkCells,
  tilesById: Record<string, TileDef>,
  tags: readonly string[],
  tagsKey: string,
): ChunkCells {
  const cache = drawnChunksFor(tilesById);
  const kept = cache.get(chunk);
  if (kept?.tagsKey === tagsKey) return kept.drawn;

  let cells: ChunkCells | null = null;
  for (const [key, stack] of Object.entries(chunk)) {
    const drawn = drawnStack(stack, tilesById, tags);
    if (drawn === stack) continue;
    cells ??= { ...chunk };
    cells[key] = drawn;
  }
  const drawn = cells ?? chunk;
  cache.set(chunk, { tagsKey, drawn });
  return drawn;
}

function drawnStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
  tags: readonly string[],
): PlacedTile[] {
  let swapped: PlacedTile[] | null = null;
  for (let i = 0; i < stack.length; i++) {
    const claimedTileId = claimedLookOf(stack[i]!, tilesById, tags);
    if (!claimedTileId) continue;
    swapped ??= [...stack];
    swapped[i] = { ...stack[i]!, tileId: claimedTileId };
  }
  return swapped ?? stack;
}

function claimedLookOf(
  placed: PlacedTile,
  tilesById: Record<string, TileDef>,
  tags: readonly string[],
): string | null {
  if (!placed.rewardTag || !tags.includes(placed.rewardTag)) return null;
  const def = tilesById[placed.tileId];
  const claimedTileId = def && resolveRewardDef(def)?.claimedTileId;
  if (!claimedTileId || !tilesById[claimedTileId]) return null;
  return claimedTileId;
}
