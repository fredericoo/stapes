import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { coordKey } from "../lib/types";
import { fitsTile } from "../lib/validation";
import { PLAYER_TILE_ID } from "./constants";
import { DIR_DELTA } from "./movement";

/**
 * Deciding where somebody who has been here before comes back in.
 *
 * The world keeps running while a player is away — a wall goes up, somebody
 * pushes a box onto the cell they logged out of, the map is re-authored — so
 * their last position is a *wish*, not a promise. This turns the wish into a
 * cell that can actually hold them.
 */

/**
 * How far the search spreads before giving up and using the spawn point.
 *
 * A bound rather than a sweep, for the reason every search in this codebase is
 * bounded: the map is headed for thousands of cells square, and "find a free
 * cell" over all of it would be O(map) at exactly the moment somebody is
 * waiting on a connection. Eight cells is a room's width — far enough that a
 * wall built across a doorway still puts you back in the room you left, and
 * near enough that it can never quietly become a teleport.
 */
export const ENTRY_SEARCH_RADIUS = 8;

/**
 * Which neighbour a ring is entered from, and therefore which of two equally
 * distant cells wins.
 *
 * Any fixed order would do for correctness; this one is fixed so that returning
 * to the same blocked cell twice puts you in the same place twice.
 */
const ENTRY_SEARCH_ORDER: readonly Direction[] = ["w", "n", "e", "s"];

/**
 * A cell the player fits in, starting from where they were.
 *
 * Bubbles outward from `preferred` — the cell itself first, then its
 * neighbours, then theirs — and takes the first that has room, falling back to
 * `fallback` when the whole neighbourhood is full.
 *
 * "Has room" is {@link fitsTile}, the same predicate the editor places against
 * and the same one {@link canWalk} ends up asking: a half-height tile dropped
 * where you were standing leaves you one unit of headroom, which is enough
 * until there is a roof on the level above, and then it is not. Everything
 * *below* the feet is left to gravity, exactly as it is for an actor arriving
 * at the spawn point — this decides where they enter, not where they end up.
 *
 * The search stays on one level. A returning player is being put back in the
 * room they left, and a cell on another floor is somewhere else however close
 * the coordinates look.
 */
export function findEntryCell(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  preferred: Coord,
  fallback: Coord,
): Coord {
  const playerDef = tilesById[PLAYER_TILE_ID];
  if (!playerDef) return fallback;

  const seen = new Set([coordKey(preferred.x, preferred.y)]);
  // Breadth-first over a queue read by index, so cells come out in ring order:
  // everything one step away is tested before anything two steps away.
  const queue: Coord[] = [preferred];

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    if (fitsTile(map, cell.x, cell.y, cell.z, playerDef, tilesById).ok) {
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
