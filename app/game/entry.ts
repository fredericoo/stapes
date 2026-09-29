import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { coordKey } from "../lib/types";
import { fitsTile } from "../lib/validation";
import { PLAYER_TILE_ID } from "./constants";
import { DIR_DELTA } from "./movement";

export const ENTRY_SEARCH_RADIUS = 8;

const ENTRY_SEARCH_ORDER: readonly Direction[] = ["w", "n", "e", "s"];

export function findEntryCell(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  preferred: Coord,
  fallback: Coord,
): Coord {
  const playerDef = tilesById[PLAYER_TILE_ID];
  if (!playerDef) return fallback;

  const seen = new Set([coordKey(preferred.x, preferred.y)]);
  const queue: Coord[] = [preferred];

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    if (
      fitsTile(map, cell.x, cell.y, cell.z, playerDef, tilesById, {
        throughPlayers: true,
      }).ok
    ) {
      return cell;
    }

    for (const direction of ENTRY_SEARCH_ORDER) {
      const { dx, dy } = DIR_DELTA[direction];
      const next = { x: cell.x + dx, y: cell.y + dy, z: cell.z };
      if (Math.abs(next.x - preferred.x) > ENTRY_SEARCH_RADIUS) continue;
      if (Math.abs(next.y - preferred.y) > ENTRY_SEARCH_RADIUS) continue;

      const key = coordKey(next.x, next.y);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }

  return fallback;
}
