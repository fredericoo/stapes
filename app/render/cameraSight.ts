/**
 * Whether the camera can see a cell, or whether the world is drawn over it.
 *
 * A different question from `game/sight`, and the difference is the whole point
 * of this file existing beside it. That module answers what a *body* can see
 * from where it stands, which is a fact about the world. This answers what is on
 * *screen*, which is a fact about the projection — and the two disagree
 * constantly. Standing in a house with the door shut you can read the name of a
 * rat in the yard, because the roof is cut away and the rat is drawn; the rat
 * cannot see you at all. Neither answer is wrong, and neither can be derived
 * from the other.
 *
 * ## The ray is a constant
 *
 * This projection puts one full level at exactly one cell up-left — see
 * {@link levelScreenOffset}, `-CELL_SIZE * z` on both axes — so inverting it
 * gives `coord = floor((worldPx + CELL_SIZE * z) / CELL_SIZE)`. Fix a pixel,
 * step a level, and the cell steps by one on each axis.
 *
 * So every cell drawn at one pixel is `(x + k, y + k, z + k)`. The camera ray in
 * voxel space is the constant direction `(+1, +1, +1)`, whatever is being looked
 * at and wherever the camera has slid to. There is no frustum to intersect and
 * no ray to march in floating point: the answer is a loop over levels doing
 * integer addition, at most {@link MAX_LEVEL} minus the subject's own level
 * long, and usually a handful.
 *
 * That is also why this is cheap enough to ask per actor per frame. The
 * expensive shape — a visibility answer for every *cell* on screen, for fog of
 * war — is a different algorithm and is deliberately not what this is.
 *
 * ## What counts as covering
 *
 * `sealsLevel` rather than `opacity`, and they come apart on exactly the case
 * that matters. Opacity is blocking *height* over a level, so a floor is height
 * zero and scores zero — which is right for a lamp, since a floor blocks nothing
 * horizontally, and wrong here, because a floor is a solid surface drawn over
 * everything beneath it. A rat in a cave read through `opacity` is in plain
 * sight through the rock above its head.
 *
 * `sealsLevel` is the half of {@link stackOcclusion} that already says "there is
 * something solid in this cell", which is what being drawn over means. It is
 * false for a cell holding nothing, and false for glass and water, so you can
 * still read a name through a window or across a pond — the same authored
 * property doing the same work it does for sight and for light.
 *
 * ## The roof-cut is honoured, and has to be
 *
 * Geometry the view has cut away is not drawn, so it cannot be covering
 * anything. Without this the rule would invert itself in the one place it is
 * most used: step indoors, the roof lifts so you can see the room, and every
 * body in it would go anonymous behind a ceiling that is no longer on screen.
 */

import { stackOcclusion } from "../lib/lighting";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL } from "../lib/types";

/** Is there something solid drawn in this cell? @see module doc */
function covers(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): boolean {
  return stackOcclusion(getStack(map, x, y, z), tilesById).sealsLevel;
}

/**
 * Is this cell behind something the camera draws in front of it?
 *
 * Walks the one diagonal every camera ray takes, from the level above the
 * subject up to whatever the view is still drawing. The subject's own cell is
 * never tested: a body is not hidden by the ground it stands on, nor by
 * whatever else shares its square — that is the same reason `hasLineOfSight`
 * leaves its endpoints alone.
 *
 * @param hideLevelsAbove the roof-cut, or undefined when nothing is cut. Levels
 *   strictly above it are not drawn and therefore hide nothing.
 */
export function isHiddenFromCamera(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
  hideLevelsAbove: number | undefined,
): boolean {
  const top = Math.min(MAX_LEVEL, hideLevelsAbove ?? MAX_LEVEL);
  for (let z = at.z + 1; z <= top; z++) {
    const step = z - at.z;
    if (covers(map, tilesById, at.x + step, at.y + step, z)) return true;
  }
  return false;
}
