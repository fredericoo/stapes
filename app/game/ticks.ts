/**
 * `TICK_MS` is 1000/30, which a double cannot hold, so counting a duration of whole
 * ticks one tick at a time lands up to 2e-9ms either side of zero for anything under
 * a minute, and a remainder above zero costs a whole extra tick. The slack is far
 * above that drift and far below the third of a millisecond that separates a
 * whole-millisecond duration from a tick boundary it does not fall on.
 */
export const TICK_SLACK_MS = 1e-6;

export function countDown(remainingMs: number, elapsedMs: number): number {
  const left = remainingMs - elapsedMs;
  return left > TICK_SLACK_MS ? left : 0;
}
