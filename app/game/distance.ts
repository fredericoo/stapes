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
 * ## Height costs a whole cell
 *
 * A level is drawn as exactly one cell up-left — see `levelScreenOffset` — so
 * the tempting weight is the projection's own: half a cell per height unit,
 * since a level is two units. It does not survive contact with the shapes worth
 * authoring.
 *
 * At half a cell, **a body one whole level straight up is nearer than a body one
 * diagonal step away on your own floor** — one against 1.414. So "everything
 * around me, but only half a level up" is not a sphere anybody can draw: no
 * radius includes the diagonal without also swallowing the storey above. That is
 * not a tuning problem, it is a statement about which shapes exist, and it was
 * found by trying to write the range down rather than by arguing about it.
 *
 * At a whole cell per height unit the shape appears. Melee at
 * {@link MELEE_RANGE_CELLS} is then exactly the 3×3 around you, half a level up
 * and half a level down — the box you would draw by hand — and the numbers that
 * produce it have room either side rather than sitting on a boundary.
 *
 * The cost is worth naming: reach no longer matches the screen. A level is twice
 * as far to hit across as it looks. That is the price of the shape, and the
 * shape is the thing players read.
 *
 * ## Squared, always
 *
 * Every comparison here is against a squared radius, and the square roots are
 * never taken. Partly for speed, but mostly because the interesting cases land
 * *on* the boundary: the corner of the melee box is exactly 3, and a hypotenuse
 * that arrived a rounding error high would drop the one case authors are most
 * likely to test by hand.
 */

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

/** Squared distance in cells, with height weighted at a cell per unit. */
export function reachDistanceSq(from: ReachPoint, to: ReachPoint): number {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const dz = from.elevAbs - to.elevAbs;
  return dx * dx + dy * dy + dz * dz;
}

/** Is `to` inside a sphere of `rangeCells` around `from`? @see module doc */
export function withinReach(
  from: ReachPoint,
  to: ReachPoint,
  rangeCells: number,
): boolean {
  return reachDistanceSq(from, to) <= rangeCells * rangeCells;
}
