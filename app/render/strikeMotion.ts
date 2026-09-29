import type { StrikeState } from "../game/strike";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { CELL_SIZE } from "../lib/types";

export const STRIKE_REACH_PX = CELL_SIZE / 2;

const OUT_FRACTION = 0.35;

export function strikeLean(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  if (t <= OUT_FRACTION) return t / OUT_FRACTION;
  return (1 - t) / (1 - OUT_FRACTION);
}

export function strikeOffset(strike: StrikeState, progress: number): { ox: number; oy: number } {
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
