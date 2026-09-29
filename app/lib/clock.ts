export const MINUTES_PER_DAY = 24 * 60;

export const MS_PER_CLOCK_MINUTE = 1000;

export type MinutesOfDay = number;

export type Illumination = {
  ambient: [number, number, number];
};

export type IlluminationKeyframe = {
  at: MinutesOfDay;
  ambient: [number, number, number];
};

export const ILLUMINATION_KEYFRAMES: readonly IlluminationKeyframe[] = [
  // oxlint-disable-next-line erasing-op
  { at: 0 * 60, ambient: [0.04, 0.05, 0.1] },
  { at: 4 * 60, ambient: [0.04, 0.05, 0.1] },
  { at: 6 * 60, ambient: [0.35, 0.32, 0.4] },
  { at: 7 * 60, ambient: [0.85, 0.75, 0.65] },
  { at: 9 * 60, ambient: [1, 1, 1] },
  { at: 16 * 60, ambient: [1, 1, 1] },
  { at: 17 * 60, ambient: [0.55, 0.4, 0.3] },
  { at: 18 * 60, ambient: [0.55, 0.4, 0.3] },
  { at: 19 * 60, ambient: [0.04, 0.05, 0.1] },
];

export const DEFAULT_EDITOR_MINUTES = 12 * 60;

export const DEFAULT_PLAY_MINUTES = 22 * 60;

export function wrapMinutes(m: number): MinutesOfDay {
  return ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function formatClock(minutes: MinutesOfDay): string {
  const m = Math.floor(wrapMinutes(minutes));
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function clockAfter(minutes: MinutesOfDay, elapsedMs: number): MinutesOfDay {
  return wrapMinutes(minutes + elapsedMs / MS_PER_CLOCK_MINUTE);
}

export function minutesOfDayAt(epochMs: number): MinutesOfDay {
  return wrapMinutes(epochMs / MS_PER_CLOCK_MINUTE);
}

export function withinHours(minutes: MinutesOfDay, fromHour: number, toHour: number): boolean {
  const t = wrapMinutes(minutes);
  const from = fromHour * 60;
  const to = toHour * 60;
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAmbient(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function sampleIllumination(
  minutes: MinutesOfDay,
  keys: readonly IlluminationKeyframe[] = ILLUMINATION_KEYFRAMES,
): Illumination {
  if (!keys.length) {
    return { ambient: [1, 1, 1] };
  }
  if (keys.length === 1) {
    const only = keys[0]!;
    return { ambient: [...only.ambient] };
  }

  const t = wrapMinutes(minutes);
  const sorted = [...keys].sort((a, b) => a.at - b.at);

  let i = 0;
  while (i < sorted.length && sorted[i]!.at <= t) i++;

  const next = sorted[i % sorted.length]!;
  const prev = sorted[(i - 1 + sorted.length) % sorted.length]!;

  let span = next.at - prev.at;
  let into = t - prev.at;
  if (span <= 0) {
    span = next.at + MINUTES_PER_DAY - prev.at;
    into = t >= prev.at ? t - prev.at : t + MINUTES_PER_DAY - prev.at;
  }

  const u = span <= 0 ? 0 : into / span;
  return { ambient: lerpAmbient(prev.ambient, next.ambient, u) };
}
