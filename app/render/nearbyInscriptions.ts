import { coveredBySomething, REACH_CELLS } from "../game/affordances";
import type { ObjectRef } from "../game/GameSession";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";

const REACH_CELLS_SQUARED = REACH_CELLS * REACH_CELLS;

const REACH_SPAN = Math.floor(REACH_CELLS);

export type NearbyInscription = {
  ref: ObjectRef;
  text: string;
  height: number;
};

export function inscribedNearby(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
): NearbyInscription[] {
  const found: NearbyInscription[] = [];

  for (let dy = -REACH_SPAN; dy <= REACH_SPAN; dy++) {
    for (let dx = -REACH_SPAN; dx <= REACH_SPAN; dx++) {
      if (dx * dx + dy * dy > REACH_CELLS_SQUARED) continue;

      const x = at.x + dx;
      const y = at.y + dy;
      const stack = getStack(map, x, y, at.z);

      for (let stackIndex = 0; stackIndex < stack.length; stackIndex++) {
        const placed = stack[stackIndex];
        if (!placed?.inscription) continue;
        if (coveredBySomething(stack, stackIndex, tilesById)) continue;
        const def = tilesById[placed.tileId];
        if (!def) continue;

        found.push({
          ref: { x, y, z: at.z, stackIndex },
          text: placed.inscription,
          height: def.height,
        });
      }
    }
  }

  return found;
}
