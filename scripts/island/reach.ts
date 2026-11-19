import { navigationLegs } from "../../app/game/navigation";
import { PLAYER_TILE_ID } from "../../app/game/constants";
import { findPlayers } from "../../app/game/player";
import { statusesById } from "../../app/lib/status";
import type { Coord, MapFile, TileDef } from "../../app/lib/types";
import { withoutBodies } from "../../app/verify/stranded";
import { flattenMap, chunkifyMap } from "../../app/lib/mapData";

/**
 * Every door opened, for the walk: the walk does not carry a door's state
 * from one leg to the next, so it would stand a body on top of a closed door
 * it had just walked into, and a house of one storey would look sealed.
 */
function doorsOpen(map: MapFile): MapFile {
  const flat = flattenMap(map);
  for (const cells of Object.values(flat.levels)) {
    for (const stack of Object.values(cells)) {
      for (const placed of stack) if (placed.tileId === "door-closed") placed.tileId = "door-open";
    }
  }
  return chunkifyMap(flat);
}

/** Every cell a player can walk, drop or climb to from where they wake, by the same legs `verify stranded` walks. */
export async function reachable(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Promise<Set<string>> {
  const statusDefs = statusesById(JSON.parse(await Bun.file("data/statuses.json").text()));
  map = doorsOpen(map);
  const start = findPlayers(map)[0]!;
  const world = {
    board: withoutBodies(map, tilesById),
    traveller: tilesById[PLAYER_TILE_ID]!,
    tilesById,
    statusDefs,
  };
  const key = (c: Coord) => `${c.x},${c.y},${c.z}`;
  const seen = new Set([key(start)]);
  const queue: Coord[] = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const leg of navigationLegs(world, queue[head]!)) {
      const k = key(leg.to);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(leg.to);
    }
  }
  return seen;
}
