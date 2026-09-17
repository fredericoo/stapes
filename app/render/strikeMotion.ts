import type { StrikeState } from "../game/strike";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { CELL_SIZE } from "../lib/types";

/**
 * Where a striking body's sprite is, part-way through the lean.
 *
 * The offset is a drawing, not a move: the body never leaves its cell for the
 * 150ms this runs, so this is only ever added to whatever motion that body
 * already has. A creature that swings while walking leans out of its own lerp.
 */

/**
 * How far out the lean goes, in world pixels.
 *
 * Half a cell is the largest distance that still reads as leaning: at a whole
 * cell the sprite stands in its neighbour's square and the pair look swapped.
 */
export const STRIKE_REACH_PX = CELL_SIZE / 2;

/**
 * The fraction of a strike spent going out, the rest coming back.
 *
 * Asymmetric on purpose: out and back at the same speed reads as bobbing. The
 * damage number is not tied to this; it fires on the tick the swing resolved,
 * which is the tick this started.
 */
const OUT_FRACTION = 0.35;

/**
 * How far into the lean a body is, 0 at home and 1 at full reach.
 *
 * Clamped at both ends: progress arrives with a frame's worth of interpolation
 * added (see `GameSession`'s `actorSnapshot`), so the last frame of a strike
 * routinely asks about a moment slightly past its end.
 */
export function strikeLean(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  if (t <= OUT_FRACTION) return t / OUT_FRACTION;
  return (1 - t) / (1 - OUT_FRACTION);
}

/**
 * World-pixel offset for a strike at this point in its life.
 *
 * The direction is measured on screen rather than on the plan: a height unit
 * is drawn up-left, so a blow at somebody directly above still has somewhere
 * to lean.
 *
 * Normalised so all eight neighbours are the same distance away; scaling the
 * axes independently would send a diagonal lean 1.41 times as far and into the
 * target's cell.
 *
 * Rounded, because a sprite drawn on a half pixel has soft edges.
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
