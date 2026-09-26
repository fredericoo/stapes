const SECONDS_PER_MINUTE = 60;

export function seconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${Number(s.toFixed(1))}s`;
  if (s < SECONDS_PER_MINUTE) return `${Math.round(s)}s`;
  const minutes = s / SECONDS_PER_MINUTE;
  return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))}m`;
}
