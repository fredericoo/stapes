import { canReach, reachPointAt } from "./combat";
import type { Reaching } from "./pathfinding";
import type { Reach } from "../lib/item";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";

type Standing = Coord & { stackIndex: number };

export type CastAim = {
  map: MapFile;
  self: Standing;
  target: Standing | null;
};

/**
 * Accepts a cell a cast at `aim().target` would land from, read through the same
 * `canReach` the cast itself is refused by. `aim` is asked on every call, since a
 * walk asks at every leg and the target moves under it.
 */
export function castReaching(
  tilesById: Record<string, TileDef>,
  reach: Reach,
  aim: () => CastAim,
): Reaching {
  return {
    /** `reach.cells` is a straight line and `within` counts grid steps, the longest of which is the diagonal. */
    within: Math.floor(reach.cells * Math.SQRT2),
    accepts: (cell) => {
      const { map, self, target } = aim();
      if (!target) return false;
      const from = reachPointAt(map, tilesById, standingIn(map, cell, self));
      return canReach(map, tilesById, from, reachPointAt(map, tilesById, target), reach);
    },
  };
}

/** A cell the walker is not in yet is stood in on top of whatever it holds. */
function standingIn(map: MapFile, cell: Coord, self: Standing): Standing {
  if (cell.x === self.x && cell.y === self.y && cell.z === self.z) return self;
  return { ...cell, stackIndex: getStack(map, cell.x, cell.y, cell.z).length };
}
