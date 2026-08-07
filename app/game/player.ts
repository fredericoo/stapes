import { getStack, listCoords } from "../lib/mapData";
import type { Coord, Direction, MapFile, PlacedTile } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { PLAYER_TILE_ID } from "./constants";

export type PlayerLocation = Coord & {
  stackIndex: number;
  placed: PlacedTile;
};

/** Find every placed tile with id `player` across all levels. */
export function findPlayers(map: MapFile): PlayerLocation[] {
  const found: PlayerLocation[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      for (let i = 0; i < stack.length; i++) {
        const placed = stack[i]!;
        if (placed.tileId === PLAYER_TILE_ID) {
          found.push({ x, y, z, stackIndex: i, placed });
        }
      }
    }
  }
  return found;
}

/**
 * Require exactly one player tile on the map.
 * @throws if zero or more than one
 */
export function requireSinglePlayer(map: MapFile): PlayerLocation {
  const players = findPlayers(map);
  if (players.length === 0) {
    throw new Error(`No tile with id "${PLAYER_TILE_ID}" on the map`);
  }
  if (players.length > 1) {
    throw new Error(
      `Expected exactly one "${PLAYER_TILE_ID}" tile, found ${players.length}`,
    );
  }
  return players[0]!;
}

/**
 * Re-read the player at a location it was last seen, or null if it moved.
 *
 * A cheap confirmation for callers holding a stale location. Most map edits do
 * not move the player at all — a plate pressing under their feet, a door
 * elsewhere — so checking the one cell they were in beats sweeping every cell
 * to rediscover them. The single-player invariant is established once by
 * {@link requireSinglePlayer}; this only re-reads, never re-counts.
 */
export function playerStillAt(
  map: MapFile,
  at: Coord & { stackIndex: number },
): PlayerLocation | null {
  const placed = getStack(map, at.x, at.y, at.z)[at.stackIndex];
  if (placed?.tileId !== PLAYER_TILE_ID) return null;
  return { x: at.x, y: at.y, z: at.z, stackIndex: at.stackIndex, placed };
}

/** Cells searched around a last-known location before falling back to a sweep. */
const PLAYER_SEARCH_RADIUS = 1;

/**
 * Find the player near where they were last seen.
 *
 * A commit moves them one cell, or one level when falling — never across the
 * map — so the neighbourhood almost always holds the answer, and finding it
 * there avoids a full sweep on exactly the frames that are already busiest.
 * Returns null when they are not nearby, leaving the caller to sweep.
 */
export function findPlayerNear(
  map: MapFile,
  near: Coord,
): PlayerLocation | null {
  const r = PLAYER_SEARCH_RADIUS;
  for (let z = near.z - r; z <= near.z + r; z++) {
    if (z < MIN_LEVEL || z > MAX_LEVEL) continue;
    const found = searchLevelNear(map, near, z, r);
    if (found) return found;
  }
  return null;
}

function searchLevelNear(
  map: MapFile,
  near: Coord,
  z: number,
  r: number,
): PlayerLocation | null {
  for (let y = near.y - r; y <= near.y + r; y++) {
    for (let x = near.x - r; x <= near.x + r; x++) {
      const stack = getStack(map, x, y, z);
      const i = stack.findIndex((p) => p.tileId === PLAYER_TILE_ID);
      if (i >= 0) return { x, y, z, stackIndex: i, placed: stack[i]! };
    }
  }
  return null;
}

export function playerDirection(loc: PlayerLocation): Direction {
  return loc.placed.direction ?? "s";
}
