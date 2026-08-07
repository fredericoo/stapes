/**
 * In-game clock: minutes past midnight (0…1439), with illumination sampled
 * by lerping a few keyframe hours.
 */

export const MINUTES_PER_DAY = 24 * 60;

/** One real-time second = one game minute. */
export const GAME_MINUTE_MS = 1000;

/** One game minute advances the clock by one hour. */
export const CLOCK_MINUTES_PER_GAME_MINUTE = 60;

export type MinutesOfDay = number;

export type Illumination = {
  ambient: [number, number, number];
  /** WebGL clear colour, 0xRRGGBB. */
  background: number;
};

export type IlluminationKeyframe = {
  /** Minutes past midnight. */
  at: MinutesOfDay;
  ambient: [number, number, number];
  background: number;
};

/**
 * Day cycle keyframes. Night holds flat from 19:00 through 04:00; dawn
 * only starts after that. Wrapped at midnight so the plateau spans 00:00.
 */
export const ILLUMINATION_KEYFRAMES: readonly IlluminationKeyframe[] = [
  // Night plateau (held through midnight via matching 19:00 / 04:00 keys)
  { at: 0 * 60, ambient: [0.04, 0.05, 0.1], background: 0x0a0d1a },
  { at: 4 * 60, ambient: [0.04, 0.05, 0.1], background: 0x0a0d1a },
  { at: 6 * 60, ambient: [0.35, 0.32, 0.4], background: 0x3a3850 },
  { at: 7 * 60, ambient: [0.85, 0.75, 0.65], background: 0x8a7a68 },
  // Day plateau 09:00–16:00 → dusk by 17:00 → night by 19:00
  { at: 9 * 60, ambient: [1, 1, 1], background: 0xb8b09e },
  { at: 16 * 60, ambient: [1, 1, 1], background: 0xb8b09e },
  { at: 17 * 60, ambient: [0.55, 0.4, 0.3], background: 0x6a5040 },
  { at: 18 * 60, ambient: [0.55, 0.4, 0.3], background: 0x6a5040 },
  { at: 19 * 60, ambient: [0.04, 0.05, 0.1], background: 0x0a0d1a },
];

/** Noon — editor default. */
export const DEFAULT_EDITOR_MINUTES = 12 * 60;

/** Late evening — play default (was `"night"`). */
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

/** Advance the clock by `dtMs` of real time at the play-mode rate. */
export function advanceClock(minutes: number, dtMs: number): MinutesOfDay {
  return wrapMinutes(
    minutes + (dtMs / GAME_MINUTE_MS) * CLOCK_MINUTES_PER_GAME_MINUTE,
  );
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

/** Lerp 0xRRGGBB channels in linear space. */
function lerpBackground(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return (r << 16) | (g << 8) | bl;
}

/**
 * Sample sky colour + clear colour at `minutes`. Keyframes wrap so the
 * last → first span crosses midnight.
 */
export function sampleIllumination(
  minutes: MinutesOfDay,
  keys: readonly IlluminationKeyframe[] = ILLUMINATION_KEYFRAMES,
): Illumination {
  if (!keys.length) {
    return { ambient: [1, 1, 1], background: 0xb8b09e };
  }
  if (keys.length === 1) {
    const only = keys[0]!;
    return { ambient: [...only.ambient], background: only.background };
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
    // Wrapped midnight segment: prev is last keyframe, next is first.
    span = next.at + MINUTES_PER_DAY - prev.at;
    into = t >= prev.at ? t - prev.at : t + MINUTES_PER_DAY - prev.at;
  }

  const u = span <= 0 ? 0 : into / span;
  return {
    ambient: lerpAmbient(prev.ambient, next.ambient, u),
    background: lerpBackground(prev.background, next.background, u),
  };
}
