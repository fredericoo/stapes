/**
 * In-game clock: minutes past midnight (0…1439), with illumination sampled
 * by lerping a few keyframe hours.
 */

export const MINUTES_PER_DAY = 24 * 60;

/** One real second is one minute on the game clock — a day is 24 minutes. */
export const MS_PER_CLOCK_MINUTE = 1000;

export type MinutesOfDay = number;

/**
 * The sky colour alone. The clear colour behind the world used to ride along
 * here and follow the hour; it is now `VOID_BACKGROUND` in `./lighting`, fixed,
 * because what shows through where there are no tiles is not sky but nothing.
 */
export type Illumination = {
  ambient: [number, number, number];
};

export type IlluminationKeyframe = {
  /** Minutes past midnight. */
  at: MinutesOfDay;
  ambient: [number, number, number];
};

/**
 * Day cycle keyframes. Night holds flat from 19:00 through 04:00; dawn
 * only starts after that. Wrapped at midnight so the plateau spans 00:00.
 */
export const ILLUMINATION_KEYFRAMES: readonly IlluminationKeyframe[] = [
  // Night plateau (held through midnight via matching 19:00 / 04:00 keys)
  { at: 0 * 60, ambient: [0.04, 0.05, 0.1] },
  { at: 4 * 60, ambient: [0.04, 0.05, 0.1] },
  { at: 6 * 60, ambient: [0.35, 0.32, 0.4] },
  { at: 7 * 60, ambient: [0.85, 0.75, 0.65] },
  // Day plateau 09:00–16:00 → dusk by 17:00 → night by 19:00
  { at: 9 * 60, ambient: [1, 1, 1] },
  { at: 16 * 60, ambient: [1, 1, 1] },
  { at: 17 * 60, ambient: [0.55, 0.4, 0.3] },
  { at: 18 * 60, ambient: [0.55, 0.4, 0.3] },
  { at: 19 * 60, ambient: [0.04, 0.05, 0.1] },
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

/**
 * What the clock reads `elapsedMs` of real time after it read `minutes`.
 *
 * A span since a known reading rather than a per-frame accumulation: frame
 * deltas are clamped and a backgrounded tab gets a handful of them, so a clock
 * summed frame by frame runs slow by however long it spent unfocused. Two
 * clients that started in agreement would then quietly stop agreeing.
 */
export function clockAfter(
  minutes: MinutesOfDay,
  elapsedMs: number,
): MinutesOfDay {
  return wrapMinutes(minutes + elapsedMs / MS_PER_CLOCK_MINUTE);
}

/**
 * Time of day at a wall-clock instant. The shared world's clock.
 *
 * A pure function of time, so the server has no clock to tick and none to
 * checkpoint: an idle world can hibernate for an hour and the sky is still
 * where everyone left it, and a client that joins late sees the same sky as
 * everyone already standing there.
 */
export function minutesOfDayAt(epochMs: number): MinutesOfDay {
  return wrapMinutes(epochMs / MS_PER_CLOCK_MINUTE);
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

/**
 * Sample the sky colour at `minutes`. Keyframes wrap so the last → first span
 * crosses midnight.
 */
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
    // Wrapped midnight segment: prev is last keyframe, next is first.
    span = next.at + MINUTES_PER_DAY - prev.at;
    into = t >= prev.at ? t - prev.at : t + MINUTES_PER_DAY - prev.at;
  }

  const u = span <= 0 ? 0 : into / span;
  return { ambient: lerpAmbient(prev.ambient, next.ambient, u) };
}
