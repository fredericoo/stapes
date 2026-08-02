import type { MapFile, PlacedTile, TileDef } from "./types";
import { CHUNK_SIZE, coordKey, levelKey, parseCoordKey } from "./types";

export function emptyMap(): MapFile {
  return { version: 1, levels: {} };
}

export function getStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): PlacedTile[] {
  const level = map.levels[levelKey(z)];
  if (!level) return [];
  return level[coordKey(x, y)] ?? [];
}

export function stackHeight(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number {
  let h = 0;
  for (const p of stack) {
    const def = tilesById[p.tileId];
    h += def?.height ?? 0;
  }
  return h;
}

/** Elevation under the tile at stackIndex (sum of heights below it). */
export function elevationAt(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  let e = 0;
  for (let i = 0; i < stackIndex; i++) {
    const def = tilesById[stack[i]!.tileId];
    e += def?.height ?? 0;
  }
  return e;
}

/**
 * Copy-on-write path update: only the touched level and cell get new objects.
 * Untouched levels and cells keep their identity so the renderer can diff by
 * reference and rebuild only dirty chunks.
 *
 * Callers must pass a freshly built `stack` array — we do not clone it.
 */
function setStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
): MapFile {
  const zk = levelKey(z);
  const ck = coordKey(x, y);
  const level = { ...(map.levels[zk] ?? {}) };
  if (stack.length === 0) delete level[ck];
  else level[ck] = stack;
  const levels = { ...map.levels };
  if (Object.keys(level).length === 0) delete levels[zk];
  else levels[zk] = level;
  return { version: 1, levels };
}

export function clearStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): MapFile {
  return setStack(map, x, y, z, []);
}

export function replaceStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
): MapFile {
  return setStack(map, x, y, z, stack);
}

export function appendTile(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  placed: PlacedTile,
): MapFile {
  const stack = [...getStack(map, x, y, z), placed];
  return setStack(map, x, y, z, stack);
}

export function removeTileAt(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
): MapFile {
  const stack = [...getStack(map, x, y, z)];
  if (stackIndex < 0 || stackIndex >= stack.length) return map;
  stack.splice(stackIndex, 1);
  return setStack(map, x, y, z, stack);
}

export function reorderStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  fromIndex: number,
  toIndex: number,
): MapFile {
  const stack = [...getStack(map, x, y, z)];
  if (
    fromIndex < 0 ||
    fromIndex >= stack.length ||
    toIndex < 0 ||
    toIndex >= stack.length ||
    fromIndex === toIndex
  ) {
    return map;
  }
  const [item] = stack.splice(fromIndex, 1);
  stack.splice(toIndex, 0, item!);
  return setStack(map, x, y, z, stack);
}

export function updatePlacedDirection(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  direction: PlacedTile["direction"],
): MapFile {
  const stack = getStack(map, x, y, z).map((p, i) =>
    i === stackIndex ? { ...p, direction } : { ...p },
  );
  return setStack(map, x, y, z, stack);
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function coordToChunk(x: number, y: number): { cx: number; cy: number } {
  return {
    cx: Math.floor(x / CHUNK_SIZE),
    cy: Math.floor(y / CHUNK_SIZE),
  };
}

/** List all occupied coords on a level. */
export function listCoords(
  map: MapFile,
  z: number,
): Array<{ x: number; y: number; stack: PlacedTile[] }> {
  const level = map.levels[levelKey(z)];
  if (!level) return [];
  return Object.entries(level).map(([key, stack]) => {
    const { x, y } = parseCoordKey(key);
    return { x, y, stack };
  });
}

export function serializeMap(map: MapFile): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

export function parseMap(json: string): MapFile {
  const data = JSON.parse(json) as MapFile;
  if (data.version !== 1) {
    throw new Error(`Unsupported map version: ${String(data.version)}`);
  }
  return data;
}
