import type { StrikeState } from "../game/strike";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { CELL_SIZE } from "../lib/types";

/**
 * Where a striking body's sprite is, part-way through the lean.
 *
 * Pure, and out here rather than on the renderer for the reason `./slideMotion`
 * is: the arithmetic is the whole of the behaviour and it wants a test, while
 * the renderer around it wants a canvas.
 *
 * The offset is a *drawing*, not a move. The body never leaves the cell it is
 * standing in — nothing in the simulation is anywhere else for the 150ms this
 * runs — so this is only ever added to whatever motion that body already has.
 * A creature that swings while walking leans out of its own lerp.
 */

/**
 * How far out the lean goes, in world pixels.
 *
 * Half a cell, which is the largest distance that still reads as *leaning* — at
 * a whole cell the sprite is standing in its neighbour's square and the pair
 * look swapped rather than fighting. Four pixels at this cell size, so the whole
 * animation is four positions: the coarseness is the medium, not a compromise.
 */
export const STRIKE_REACH_PX = CELL_SIZE / 2;

/**
 * The fraction of a strike spent going out, the rest coming back.
 *
 * Asymmetric on purpose. Out and back at the same speed is a body bobbing; the
 * snap out and the slower recovery is what makes one of the two ends read as the
 * blow. Where in the animation the damage number appears is not tied to this —
 * the number is fired on the tick the swing resolved, which is the tick this
 * started.
 */
const OUT_FRACTION = 0.35;

/**
 * How far into the lean a body is, 0 at home and 1 at full reach.
 *
 * Clamped at both ends rather than trusting the caller: progress arrives with a
 * frame's worth of interpolation added to it — see `GameSession`'s
 * `actorSnapshot` — so the last frame of a strike routinely asks about a moment
 * slightly past the end of it.
 */
export function strikeLean(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  if (t <= OUT_FRACTION) return t / OUT_FRACTION;
  return (1 - t) / (1 - OUT_FRACTION);
}

/**
 * World-pixel offset for a strike at this point in its life.
 *
 * The direction is measured on screen rather than on the plan, which is what
 * makes a blow struck at somebody half a level up lean *at* them: a height unit
 * is drawn up-left, so a body directly above is offset from you on both axes and
 * a body with no plan delta at all still has somewhere to go.
 *
 * Normalised, so all eight neighbours are the same distance away. Scaling the
 * axes independently would send a diagonal strike 1.41 times as far as a
 * straight one — the same over-travel that makes a diagonal walk look faster —
 * and here it would be a lean that lands inside the target's cell.
 *
 * Rounded, because a sprite drawn on a half pixel is a sprite whose every edge
 * is soft for the length of a fight.
 */
export function strikeOffset(
  strike: StrikeState,
  progress: number,
): { ox: number; oy: number } {
  const elevPx = strike.dElev * PX_PER_HEIGHT;
  const towardX = strike.dx * CELL_SIZE - elevPx;
  const towardY = strike.dy * CELL_SIZE - elevPx;
  const length = Math.hypot(towardX, towardY);
  if (length === 0) return { ox: 0, oy: 0 };

  const reach = (STRIKE_REACH_PX * strikeLean(progress)) / length;
  return {
    ox: Math.round(towardX * reach),
    oy: Math.round(towardY * reach),
  };
}
