import {
  appendTile,
  getStack,
  removeTileAt,
  replaceStack,
} from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL } from "../lib/types";

/** Remove the tile at stackIndex and return the new map. */
export function removeEntity(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
): MapFile {
  return removeTileAt(map, x, y, z, stackIndex);
}

/**
 * Normalize a standing surface so the entity is stored on the level where
 * its feet sit. When scenery elevation ≥ 4, promote onto the level above.
 */
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
 * Place `placed` on top of the stack at (x,y,z).
 * Always appends onto that stack so standing elevation matches the surface
 * (including overflowing stacks taller than one level). Do not promote onto an
 * empty level above — that would snap feet down to the level base.
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

/** Move an entity from one cell to another (end-of-walk commit). */
export function moveEntity(
  map: MapFile,
  from: { x: number; y: number; z: number; stackIndex: number },
  to: { x: number; y: number; z: number },
  direction: Direction,
  tilesById: Record<string, TileDef>,
): MapFile {
  const stack = getStack(map, from.x, from.y, from.z);
  const entity = stack[from.stackIndex];
  if (!entity) return map;

  const placed: PlacedTile = { tileId: entity.tileId, direction };
  let next = removeEntity(map, from.x, from.y, from.z, from.stackIndex);
  next = placeEntityOnSurface(next, to.x, to.y, to.z, placed, tilesById);
  return next;
}

/** Update only the direction on a placed entity (in place). */
export function setEntityDirection(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  direction: Direction,
): MapFile {
  const stack = getStack(map, x, y, z);
  if (!stack[stackIndex]) return map;
  const next = stack.map((p, i) =>
    i === stackIndex ? { ...p, direction } : p,
  );
  return replaceStack(map, x, y, z, next);
}
