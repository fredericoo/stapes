/**
 * How far apart two things are, when the answer decides whether one can touch
 * the other.
 *
 * One metric, shared by every kind of reach, because the alternative is what
 * this codebase already had: a swing counted in a square, a brain's "within five
 * cells" counted in steps on the plan, and a level worth either nothing or
 * everything depending on which of them you asked. Three answers to one
 * question, and no way to author a creature against all three at once.
 *
 * ## A disc and a height, not a sphere
 *
 * This was a sphere, with height weighted at a whole cell per unit so that the
 * one shape anybody wanted to author — the 3×3 box, half a level either way —
 * fell out of a single radius. It worked for exactly that shape and for nothing
 * beyond it. A bow is the same question with a bigger answer, and the answer a
 * sphere gives is wrong: at six cells' radius, "six cells across the yard"
 * necessarily also means "six cells straight up", which is three storeys of
 * building nobody meant to shoot through. There is no weighting that fixes it,
 * because a weighting only decides *where* the sphere bulges, never that the
 * shape has a flat lid.
 *
 * So reach is two independent tests: a disc on the plan, and a height either
 * side of it. Every shape worth authoring exists in that pair — melee is a small
 * disc and a thin band, a bow is a wide disc and a band a storey or two tall,
 * and a thing that can only hit its own floor is a band of nothing.
 *
 * **It is also what the rest of the game was already doing in private.**
 * `./affordances` measures what you can touch as a disc plus a level slack, and
 * a brain's `in_range` measures plan steps plus its sight's up and down. Neither
 * could be written against the sphere, so neither was. This is those two, and
 * the fight, agreeing at last.
 *
 * ## Height is in height units
 *
 * Two to a level, and measured absolutely — not in floors. A body standing on a
 * crate is half a level above the floor it shares with you, and a rule counting
 * floors cannot see the crate at all. It is also the only unit in which an arm's
 * reach can be said: half a level up is one unit, and there is no half-floor.
 *
 * ## Squared on the plan, always
 *
 * The plan comparison runs against a squared radius and the square root is never
 * taken. Partly for speed, but mostly because the interesting cases land *on*
 * the boundary: the diagonal neighbour is exactly 2 and the cell two along is
 * exactly 4, so a radius meant to separate them wants room on both sides rather
 * than a hypotenuse that arrived a rounding error high.
 *
 * The height comparison is not squared, because it has no corner to land on —
 * it is one subtraction against one bound.
 */

import type { Reach } from "../lib/item";
import { HEIGHT_PER_LEVEL } from "../lib/types";

/**
 * A point reach is measured between: a cell on the plan, and a height.
 *
 * Elevation is absolute and in height units, not a level — which is the whole
 * reason this type exists rather than {@link Coord}. Standing on a crate does
 * not change which floor you are on and very much does change what can reach
 * you, and a rule written on `z` cannot see the crate at all.
 */
export type ReachPoint = { x: number; y: number; elevAbs: number };

/** Absolute elevation of a bare level, for callers measuring floor to floor. */
export function levelElevation(z: number): number {
  return z * HEIGHT_PER_LEVEL;
}

/**
 * Squared distance on the plan, in cells. Height is not in it at all.
 *
 * @see the module doc for why the two axes are never mixed into one number.
 */
export function planDistanceSq(from: ReachPoint, to: ReachPoint): number {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  return dx * dx + dy * dy;
}

/** How far apart two points are in height units, either way. @see module doc */
export function heightApart(from: ReachPoint, to: ReachPoint): number {
  return Math.abs(from.elevAbs - to.elevAbs);
}

/** Is `to` inside the disc and the band `reach` describes? @see module doc */
export function withinReach(
  from: ReachPoint,
  to: ReachPoint,
  reach: Reach,
): boolean {
  if (heightApart(from, to) > reach.height) return false;
  return planDistanceSq(from, to) <= reach.cells * reach.cells;
}
