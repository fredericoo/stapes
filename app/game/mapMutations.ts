import {
  appendTile,
  getStack,
  landedPlacement,
  removeTileAt,
  replaceStack,
  setStacks,
} from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL } from "../lib/types";

export function removeEntity(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
): MapFile {
  return removeTileAt(map, x, y, z, stackIndex);
}

export function normalizeStandingCell(
  z: number,
  sceneryElev: number,
): { z: number; elevInLevel: number } {
  let nz = z;
  let e = sceneryElev;
  while (e >= HEIGHT_PER_LEVEL && nz < MAX_LEVEL) {
    e -= HEIGHT_PER_LEVEL;
    nz += 1;
  }
  return { z: nz, elevInLevel: e };
}

/**
 * Appends onto the existing stack. Promoting the placement onto an empty level
 * above would snap its feet down to that level's base.
 */
export function placeEntityOnSurface(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  placed: PlacedTile,
  _tilesById?: Record<string, TileDef>,
): MapFile {
  return appendTile(map, x, y, z, placed);
}

export function moveEntity(
  map: MapFile,
  from: { x: number; y: number; z: number; stackIndex: number },
  to: { x: number; y: number; z: number },
  direction: Direction | undefined,
  _tilesById?: Record<string, TileDef>,
): MapFile {
  return moveColumn(map, from, 1, to, direction);
}

/**
 * Writes source and destination in one `setStacks` call. A loop of `moveEntity`
 * would leave a rider without the object it stands on between iterations, where
 * the gravity and pressure-plate passes can see it.
 */
export function moveColumn(
  map: MapFile,
  from: { x: number; y: number; z: number; stackIndex: number },
  count: number,
  to: { x: number; y: number; z: number },
  direction: Direction | undefined,
): MapFile {
  const stack = getStack(map, from.x, from.y, from.z);
  const moving = stack.slice(from.stackIndex, from.stackIndex + count);
  if (moving.length === 0) return map;

  const placed: PlacedTile[] = moving.map((entity) => ({
    ...landedPlacement(entity),
    direction: direction ?? entity.direction,
  }));
  const fromStack = [...stack];
  fromStack.splice(from.stackIndex, moving.length);

  const sameCell = from.x === to.x && from.y === to.y && from.z === to.z;
  const toBase = sameCell ? fromStack : getStack(map, to.x, to.y, to.z);
  const toStack = [...toBase, ...placed];

  return setStacks(
    map,
    sameCell
      ? [{ x: to.x, y: to.y, z: to.z, stack: toStack }]
      : [
          { x: from.x, y: from.y, z: from.z, stack: fromStack },
          { x: to.x, y: to.y, z: to.z, stack: toStack },
        ],
  );
}

export function setEntityDirection(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  direction: Direction,
): MapFile {
  const stack = getStack(map, x, y, z);
  const current = stack[stackIndex];
  if (!current) return map;
  /**
   * Already facing that way: return the same map object. Callers reassert
   * facing every tick a key is held, and a new object here would read
   * downstream as a real edit, invalidating lighting and rebuilding geometry
   * for a frame in which nothing moved.
   */
  if (current.direction === direction) return map;
  const next = stack.map((p, i) => (i === stackIndex ? { ...p, direction } : p));
  return replaceStack(map, x, y, z, next);
}
