export const HEALTH_BAR_FILL_STEPS = 24;

const TRACK_BORDER_BRICKS = 1;

const MIN_TRACK_BRICKS = 4;

export function healthBarTrackBricks(cellCssPx: number, brickCssPx: number): number {
  if (!(brickCssPx > 0)) return MIN_TRACK_BRICKS;
  const bricksAcrossCell = Math.floor(cellCssPx / brickCssPx);
  return Math.max(MIN_TRACK_BRICKS, bricksAcrossCell - TRACK_BORDER_BRICKS * 2);
}

const TRACK_BRICKS_PER_FILL_BRICK = 5;

const MIN_FILL_HEIGHT_BRICKS = 2;
const MAX_FILL_HEIGHT_BRICKS = 4;

export function healthBarFillHeightBricks(trackBricks: number): number {
  const wanted = Math.round(trackBricks / TRACK_BRICKS_PER_FILL_BRICK);
  return Math.max(MIN_FILL_HEIGHT_BRICKS, Math.min(MAX_FILL_HEIGHT_BRICKS, wanted));
}

export const HEALTH_BAR_STOPS: ReadonlyArray<{ upTo: number; color: string }> = [
  { upTo: 0.15, color: "#6b0f1a" },
  { upTo: 0.35, color: "#d12d2d" },
  { upTo: 0.65, color: "#e0b020" },
  { upTo: 1, color: "#3fbf50" },
];

export function healthFraction(hp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

export function healthBarColor(fraction: number): string {
  for (const stop of HEALTH_BAR_STOPS) {
    if (fraction <= stop.upTo) return stop.color;
  }
  return HEALTH_BAR_STOPS[HEALTH_BAR_STOPS.length - 1]!.color;
}

export function healthBarFillBricks(
  fraction: number,
  trackBricks: number = HEALTH_BAR_FILL_STEPS,
): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return trackBricks;
  const bricks = Math.round(fraction * trackBricks);
  return Math.min(trackBricks - 1, Math.max(1, bricks));
}
