import type { Direction, MapFile, PlacedTile, TileDef } from "./types";
import {
  CHUNK_SIZE,
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
  physicalHeight,
  resolveIntangible,
  resolveWalkable,
} from "./types";

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
    if (def) h += physicalHeight(def);
  }
  return h;
}

/** Elevation under the tile at stackIndex (sum of physical heights below it). */
export function elevationAt(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  let e = 0;
  for (let i = 0; i < stackIndex; i++) {
    const def = tilesById[stack[i]!.tileId];
    if (def) e += physicalHeight(def);
  }
  return e;
}

/**
 * Topmost non-intangible tile in a stack. Intangibles don't form a solid
 * surface — walk/land checks look through them to the tile underneath.
 */
export function solidTopOfStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const placed = stack[i]!;
    const def = tilesById[placed.tileId];
    if (def && resolveIntangible(def)) continue;
    return placed;
  }
  return null;
}

/**
 * Absolute standing elevation for a stack surface:
 * `z * HEIGHT_PER_LEVEL + stackHeight(stack)`.
 */
export function absoluteStandingElevation(
  z: number,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number {
  return z * HEIGHT_PER_LEVEL + stackHeight(stack, tilesById);
}

/**
 * Elevation (within the level) of the highest walkable tile top in `stack`.
 * Null when no walkable tile is present.
 */
export function walkableElevInStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  let elev = 0;
  let best: number | null = null;
  for (const p of stack) {
    const def = tilesById[p.tileId];
    if (!def) continue;
    elev += physicalHeight(def);
    // Intangible walkable tops don't form a standing plane — pass through.
    if (resolveWalkable(def) && !resolveIntangible(def)) best = elev;
  }
  return best;
}

/** Absolute walkable standing elevation for a stack, or null. */
export function absoluteWalkableElevation(
  z: number,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  const elev = walkableElevInStack(stack, tilesById);
  if (elev == null) return null;
  return z * HEIGHT_PER_LEVEL + elev;
}

/**
 * When `below` at `zBelow` is an exactly-full level whose walkable top seals
 * the level, returns the floor abs at the base of `zBelow + 1`.
 * Non-walkable fillers (e.g. a lone tree) do not form a floor.
 */
export function walkableFloorAbove(
  zBelow: number,
  below: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  if (stackHeight(below, tilesById) !== HEIGHT_PER_LEVEL) return null;
  const walkAbs = absoluteWalkableElevation(zBelow, below, tilesById);
  const floorAbs = (zBelow + 1) * HEIGHT_PER_LEVEL;
  if (walkAbs !== floorAbs) return null;
  return floorAbs;
}

/**
 * The walkable placed tile whose top is at `elevInLevel` within `stack`,
 * or null if none (e.g. floor-only surface).
 */
export function walkableTileAtElev(
  stack: PlacedTile[],
  elevInLevel: number,
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  let elev = 0;
  for (const p of stack) {
    const def = tilesById[p.tileId];
    if (!def) continue;
    elev += physicalHeight(def);
    if (
      resolveWalkable(def) &&
      !resolveIntangible(def) &&
      elev === elevInLevel
    ) {
      return p;
    }
  }
  return null;
}

/**
 * The placed tile forming the solid surface at absolute `abs`, or null when
 * nothing surfaces there. The first stack whose top lands on `abs` wins even
 * if it is not walkable — that tile still owns the plane, and callers that
 * care about standing on it check {@link resolveWalkable} themselves.
 * Intangible tops are skipped so pass-through tiles don't block standing.
 */
export function surfaceTileAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): PlacedTile | null {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = stack.filter((_, i) => i !== exclude.stackIndex);
    }
    if (stack.length === 0) continue;
    const top = absoluteStandingElevation(z, stack, tilesById);
    if (top !== abs) continue;
    const solid = solidTopOfStack(stack, tilesById);
    if (solid) return solid;
  }

  // Floor formed by a full walkable level below — its top tile is the surface.
  const zFloor = Math.floor(abs / HEIGHT_PER_LEVEL);
  if (abs === zFloor * HEIGHT_PER_LEVEL && zFloor > MIN_LEVEL) {
    let below = getStack(map, x, y, zFloor - 1);
    if (exclude && exclude.z === zFloor - 1) {
      below = below.filter((_, i) => i !== exclude.stackIndex);
    }
    if (walkableFloorAbove(zFloor - 1, below, tilesById) === abs) {
      return solidTopOfStack(below, tilesById);
    }
  }
  return null;
}

/** True when a solid stack top at absolute `abs` is walkable. */
export function isWalkableSurfaceAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): boolean {
  const placed = surfaceTileAt(map, x, y, abs, tilesById, exclude);
  if (!placed) return false;
  const def = tilesById[placed.tileId];
  return def ? resolveWalkable(def) : true;
}

/** Climb-from source underfoot at absolute standing elevation `fromAbs`. */
export function climbFromSourceAt(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): { def: TileDef; direction: Direction } | null {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = stack.filter((_, i) => i !== exclude.stackIndex);
    }
    const walkAbs = absoluteWalkableElevation(z, stack, tilesById);
    if (walkAbs !== fromAbs) continue;
    const elevIn = fromAbs - z * HEIGHT_PER_LEVEL;
    const placed = walkableTileAtElev(stack, elevIn, tilesById);
    if (!placed) continue;
    const def = tilesById[placed.tileId];
    if (!def) continue;
    return { def, direction: placed.direction ?? "s" };
  }
  return null;
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
