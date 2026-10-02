const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const ONE_DECIMAL_BELOW = 10;

function withUnit(value: number, unit: string): string {
  return `${Number(value.toFixed(value < ONE_DECIMAL_BELOW ? 1 : 0))}${unit}`;
}

export function formatDuration(ms: number): string {
  const s = ms / MS_PER_SECOND;
  if (s < SECONDS_PER_MINUTE) return withUnit(s, "s");
  const minutes = s / SECONDS_PER_MINUTE;
  if (minutes < MINUTES_PER_HOUR) return withUnit(minutes, "m");
  return withUnit(minutes / MINUTES_PER_HOUR, "h");
}

/**
 * Whole units rounded up, the way a game buff timer reads: 61 seconds left is
 * "2m", so the number never claims less time than remains.
 */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / MS_PER_SECOND));
  if (s < SECONDS_PER_MINUTE) return `${s}s`;
  const minutes = Math.ceil(s / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  return `${Math.ceil(minutes / MINUTES_PER_HOUR)}h`;
}
