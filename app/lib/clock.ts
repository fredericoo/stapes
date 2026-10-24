export const MINUTES_PER_DAY = 24 * 60;

export const MS_PER_CLOCK_MINUTE = 1000;

export type MinutesOfDay = number;

type Rgb = [number, number, number];

/**
 * `ambient` is skylight: what a cell gets from the open sky whichever way the
 * sun points, so it is also the colour of a shadow. `sun` is added on top only
 * where the cell can see the sun at `sunArc`.
 */
export type Illumination = {
  ambient: Rgb;
  sun: Rgb;
  sunArc: number;
};

export type IlluminationKeyframe = {
  at: MinutesOfDay;
  ambient: Rgb;
  sun?: Rgb;
};

const NO_SUN: Rgb = [0, 0, 0];

export const SUNRISE_MINUTES = 5 * 60;

export const SUNSET_MINUTES = 20 * 60;

export const ILLUMINATION_KEYFRAMES: readonly IlluminationKeyframe[] = [
  // oxlint-disable-next-line erasing-op
  { at: 0 * 60, ambient: [0.04, 0.05, 0.1] },
  { at: 4 * 60, ambient: [0.04, 0.05, 0.1] },
  { at: 5 * 60, ambient: [0.2, 0.19, 0.22], sun: [0.12, 0.1, 0.03] },
  { at: 7 * 60, ambient: [0.45, 0.44, 0.42], sun: [0.55, 0.5, 0.28] },
  { at: 10 * 60, ambient: [0.5, 0.54, 0.62], sun: [0.55, 0.5, 0.42] },
  { at: 16 * 60, ambient: [0.5, 0.54, 0.62], sun: [0.55, 0.5, 0.42] },
  { at: 18 * 60, ambient: [0.45, 0.38, 0.4], sun: [0.6, 0.4, 0.2] },
  { at: 19 * 60 + 30, ambient: [0.34, 0.22, 0.24], sun: [0.5, 0.18, 0.06] },
  { at: 20 * 60 + 30, ambient: [0.16, 0.13, 0.26] },
  { at: 22 * 60, ambient: [0.08, 0.08, 0.18] },
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

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Where the sun is along its east-to-west arc: 0 on the eastern horizon at
 * sunrise, 0.5 overhead, 1 on the western horizon at sunset. Clamped at both
 * ends, which is harmless because the sun colour is black outside them.
 */
export function sunArcAt(minutes: MinutesOfDay): number {
  const t = (wrapMinutes(minutes) - SUNRISE_MINUTES) / (SUNSET_MINUTES - SUNRISE_MINUTES);
  return Math.min(1, Math.max(0, t));
}

export function sampleIllumination(
  minutes: MinutesOfDay,
  keys: readonly IlluminationKeyframe[] = ILLUMINATION_KEYFRAMES,
): Illumination {
  const sunArc = sunArcAt(minutes);
  if (!keys.length) {
    return { ambient: [1, 1, 1], sun: [...NO_SUN], sunArc };
  }
  if (keys.length === 1) {
    const only = keys[0]!;
    return { ambient: [...only.ambient], sun: [...(only.sun ?? NO_SUN)], sunArc };
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
  return {
    ambient: lerpRgb(prev.ambient, next.ambient, u),
    sun: lerpRgb(prev.sun ?? NO_SUN, next.sun ?? NO_SUN, u),
    sunArc,
  };
}
