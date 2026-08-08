import { listCoords } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { PLAYER_TILE_ID } from "./constants";

/**
 * Reading the authored `player` tile.
 *
 * Narrow on purpose: this is about the tile an author places to mark where the
 * world starts, not about the actors that run there. Once a session is live,
 * locating somebody is `./actors` — it knows about ownership, and it does not
 * sweep the map to answer a question about one cell.
 */

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
 *
 * The invariant belongs to *authored* maps, where the tile is a spawn marker.
 * A running session breaks it the moment a second actor joins, which is why
 * nothing in the tick loop calls this.
 *
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
