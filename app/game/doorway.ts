import { getStack, isBodyPlacement } from "../lib/mapData";
import { DIRECTIONS } from "../lib/types";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { canWalk } from "./movement";

export type Eviction = { owner: string; to: Coord };

function ownedBody(placed: PlacedTile, tilesById: Record<string, TileDef>): boolean {
  return placed.owner != null && isBodyPlacement(placed, tilesById);
}

function directionBetween(from: Coord, to: Coord): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  if (dx !== 0) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

function exitOrder(placed: PlacedTile, cell: Coord, awayFrom: Coord | undefined): Direction[] {
  const pushed = awayFrom ? directionBetween(awayFrom, cell) : null;
  const facing = DIRECTIONS.find((direction) => direction === placed.direction) ?? null;
  const first = [pushed, facing].filter((direction) => direction !== null);
  return [...new Set([...first, ...DIRECTIONS])];
}

/**
 * What the bodies in a cell must do before its stack can become `next`:
 * nothing when it fits round them, one step out each when it fits only without
 * them, and null when it does not fit either way or one of them has no cell to
 * step into. A body goes away from `awayFrom` when it can, then the way it faces.
 */
export function evictionsFor(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: Coord,
  next: PlacedTile[],
  awayFrom?: Coord,
  taken: (to: Coord, owner: string) => boolean = () => false,
): Eviction[] | null {
  if (canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok) return [];
  const scenery = next.filter((placed) => !ownedBody(placed, tilesById));
  if (scenery.length === next.length) return null;
  if (!canReplaceStack(map, cell.x, cell.y, cell.z, scenery, tilesById).ok) return null;

  const evictions: Eviction[] = [];
  for (const [stackIndex, placed] of getStack(map, cell.x, cell.y, cell.z).entries()) {
    const def = tilesById[placed.tileId];
    if (!def || placed.owner == null || !ownedBody(placed, tilesById)) continue;
    const owner = placed.owner;
    const from = { x: cell.x, y: cell.y, z: cell.z, stackIndex };
    let to: Coord | null = null;
    for (const direction of exitOrder(placed, cell, awayFrom)) {
      const step = canWalk(map, from, direction, def, tilesById);
      if (!step.ok || taken(step.to, owner)) continue;
      to = step.to;
      break;
    }
    if (to === null) return null;
    evictions.push({ owner, to });
  }
  return evictions;
}
