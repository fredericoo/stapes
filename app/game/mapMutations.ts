import {
  appendTile,
  getStack,
  removeTileAt,
  replaceStack,
  setStacks,
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

/**
 * Move an entity from one cell to another (end-of-walk commit).
 * Omit `direction` to keep whatever facing the tile already had — dragged
 * scenery is repositioned without being turned.
 */
export function moveEntity(
  map: MapFile,
  from: { x: number; y: number; z: number; stackIndex: number },
  to: { x: number; y: number; z: number },
  direction: Direction | undefined,
  tilesById: Record<string, TileDef>,
): MapFile {
  const stack = getStack(map, from.x, from.y, from.z);
  const entity = stack[from.stackIndex];
  if (!entity) return map;

  // Spread, not rebuilt field by field: a placement carries per-placement state
  // (its signal channel) that a move has no business dropping.
  const placed: PlacedTile = {
    ...entity,
    direction: direction ?? entity.direction,
  };
  // Both cells in one pass. Done as remove-then-place it copies the level
  // twice, and on a populated floor that is thousands of keys copied to move
  // one tile — the dominant cost of committing a step.
  const fromStack = [...stack];
  fromStack.splice(from.stackIndex, 1);

  const sameCell = from.x === to.x && from.y === to.y && from.z === to.z;
  const toBase = sameCell ? fromStack : getStack(map, to.x, to.y, to.z);
  const toStack = [...toBase, placed];

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
  const current = stack[stackIndex];
  if (!current) return map;
  // Already facing that way: hand back the same map. Callers re-assert facing
  // every tick a key is held, and a fresh map object for an unchanged facing
  // reads downstream as a real edit — invalidating light and rebuilding the
  // level's geometry for a frame in which nothing moved.
  if (current.direction === direction) return map;
  const next = stack.map((p, i) =>
    i === stackIndex ? { ...p, direction } : p,
  );
  return replaceStack(map, x, y, z, next);
}
