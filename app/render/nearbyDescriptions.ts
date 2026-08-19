/**
 * What the things at your feet say, without being asked.
 *
 * Looking is deliberate — hold shift, point at a thing, and it tells you its
 * name and whatever is written on it. That is the right shape for *identifying*
 * something across the room, and the wrong shape for a sign: a sign is a thing
 * whose whole job is to be read by whoever walks up to it, and a player who has
 * to discover a modifier before the world will speak to them will simply walk
 * past it. So standing next to a described placement reads it out.
 *
 * **The description alone, never the name.** A look answers "what is that?" and
 * needs the name to answer it; standing beside a sign is not a question, and
 * "Sign / DANGER" reads as a label on a museum exhibit where "DANGER" reads as
 * the world talking. The name is already available to anybody who wants it, one
 * shift away.
 *
 * **The radius is {@link REACH_CELLS}, imported rather than restated.** Reading
 * a sign and reaching out to touch it are the same gesture — you are next to the
 * thing — and two numbers that mean "next to" would eventually disagree, which
 * on screen is a sign that stays silent until you take one more step for no
 * reason a player can see.
 *
 * Levels are exact here, where reach allows a floor of slack: a sign on the
 * balcony above should not be read by somebody in the room below, because they
 * cannot see it and the words would appear to come from the ceiling.
 */

import { coveredBySomething, REACH_CELLS } from "../game/affordances";
import type { ObjectRef } from "../game/GameSession";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";

const REACH_CELLS_SQUARED = REACH_CELLS * REACH_CELLS;

/**
 * Cells to sweep out from the reader on each axis. Derived from the radius
 * rather than written as 1, so widening the reach widens the sweep with it.
 */
const REACH_SPAN = Math.floor(REACH_CELLS);

/** A placement close enough to be read, and what it reads. */
export type NearbyDescription = {
  ref: ObjectRef;
  /** The placement's own text. Never empty — that is what got it in here. */
  text: string;
  /** The tile's height, for hanging the words over its head. */
  height: number;
};

/**
 * Everything within arm's length of `at` that has something written on it.
 *
 * Cheap enough to ask every frame: nine stacks, and the overwhelming majority
 * of placements fail on the missing `description` before anything else is
 * looked up. There is no index to keep in step with the map, which is the same
 * trade the look pick makes.
 */
export function describedNearby(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
): NearbyDescription[] {
  const found: NearbyDescription[] = [];

  for (let dy = -REACH_SPAN; dy <= REACH_SPAN; dy++) {
    for (let dx = -REACH_SPAN; dx <= REACH_SPAN; dx++) {
      if (dx * dx + dy * dy > REACH_CELLS_SQUARED) continue;

      const x = at.x + dx;
      const y = at.y + dy;
      const stack = getStack(map, x, y, at.z);

      for (let stackIndex = 0; stackIndex < stack.length; stackIndex++) {
        const placed = stack[stackIndex];
        if (!placed?.description) continue;
        if (coveredBySomething(stack, stackIndex, tilesById)) continue;
        const def = tilesById[placed.tileId];
        if (!def) continue;

        found.push({
          ref: { x, y, z: at.z, stackIndex },
          text: placed.description,
          height: def.height,
        });
      }
    }
  }

  return found;
}
