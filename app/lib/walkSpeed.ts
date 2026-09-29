export const MIN_WALK_SPEED_PERCENT = -90;

export const MAX_WALK_SPEED_PERCENT = 400;

const MIN_WALK_DURATION_MS = 1;

export function clampWalkSpeedPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(MIN_WALK_SPEED_PERCENT, Math.min(MAX_WALK_SPEED_PERCENT, percent));
}

export function walkDurationFrom(baseMs: number, speedPercent: number): number {
  const speed = 1 + clampWalkSpeedPercent(speedPercent) / 100;
  return Math.max(MIN_WALK_DURATION_MS, Math.round(baseMs / speed));
}
