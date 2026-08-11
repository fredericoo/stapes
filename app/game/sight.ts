/**
 * Whether one cell can see another.
 *
 * Kept out of the session for the same reason `affordances` is: this is a pure
 * question about a board, asked by a brain condition today and by anything else
 * that needs it tomorrow. Nothing here knows what a creature is.
 *
 * ## Sight is light
 *
 * A cell blocks sight when it blocks light outright — {@link stackOcclusion}'s
 * own answer, reused rather than reinvented. That single decision buys the
 * behaviour an author would otherwise have to be told about: a window is glass,
 * so it is see-through; water is light-passing, so you can see across a pond;
 * and a wall is a wall.
 *
 * `opacity >= 1` rather than `> 0` is the other half of it. Opacity is blocking
 * height over {@link HEIGHT_PER_LEVEL}, so a floor scores 0 and a crate scores a
 * half — which means **you can see over anything shorter than a full level**.
 * A creature that lost sight of somebody behind a barrel would read as blind
 * rather than as careful.
 */

import { stackOcclusion } from "../lib/lighting";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { SIGHT_LEVEL_SLACK } from "./constants";

/** Does this cell stop a line of sight dead? @see module doc */
function blocksSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): boolean {
  return stackOcclusion(getStack(map, x, y, z), tilesById).opacity >= 1;
}

/**
 * Is the path from `from` to `to` unobstructed?
 *
 * The ray is walked on the *viewer's* level whatever the target's, which is the
 * simplification {@link SIGHT_LEVEL_SLACK} admits to here: somebody standing one
 * step up a slope is seen if the ground between here and there is clear. Sight
 * through a floor is not a thing, and one level of slack is too little room for
 * it to become one.
 *
 * The endpoints are never tested. A viewer standing inside their own body would
 * otherwise blind themselves, and a target behind a full-height door they are
 * standing *in* would be invisible while in plain sight.
 *
 * The line is sampled rather than swept: one sample per step of the longer axis,
 * each rounded to a cell. That is not a supercover walk, and the difference is
 * one authored case — a perfect diagonal gap between two wall corners reads as
 * visible here, where a stricter sweep would close it. For a creature deciding
 * whether it noticed you, being generous at the corner is the better failure.
 */
export function hasLineOfSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: Coord,
  to: Coord,
): boolean {
  if (Math.abs(from.z - to.z) > SIGHT_LEVEL_SLACK) return false;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  // Adjacent, or the same cell: there is nothing in between to be in the way.
  if (steps <= 1) return true;

  for (let i = 1; i < steps; i++) {
    const x = Math.round(from.x + (dx * i) / steps);
    const y = Math.round(from.y + (dy * i) / steps);
    if (blocksSight(map, tilesById, x, y, from.z)) return false;
  }
  return true;
}
