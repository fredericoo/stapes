import { listCoords } from "../lib/mapData";
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

export function playerDirection(loc: PlayerLocation): Direction {
  return loc.placed.direction ?? "s";
}
