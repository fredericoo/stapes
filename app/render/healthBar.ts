/**
 * How much health a bar is showing, and what colour that makes it.
 *
 * Kept apart from the renderer because it is arithmetic with no scene in it,
 * which is also the only way the thresholds are assertable: "is it red yet" is a
 * question about a number, and answering it by taking a screenshot is how a
 * ramp quietly stops matching what anybody said it did.
 */

/** Bar width in world pixels — a shade under the 8px cell it hangs over. */
export const HEALTH_BAR_WIDTH_PX = 10;

/** Bar height in world pixels. Two, so the fill is legible inside its border. */
export const HEALTH_BAR_HEIGHT_PX = 2;

/** Border thickness in world pixels, drawn as a dark rect behind the bar. */
export const HEALTH_BAR_BORDER_PX = 1;

/** How far above the top of the head the bar floats, in world pixels. */
export const HEALTH_BAR_LIFT_PX = 3;

/** The unfilled part, and the border: one dark colour serving as both. */
export const HEALTH_BAR_BACKING = 0x1a1014;

/**
 * The ramp, worst first. Each entry claims everything at or below its fraction
 * that no earlier entry claimed, so the order here *is* the thresholds.
 *
 * Four stops rather than a gradient because the art is palettised and a smooth
 * fade would land on a handful of indistinguishable colours anyway — and because
 * a player reads "it went red" far faster than they read a hue.
 */
export const HEALTH_BAR_STOPS: ReadonlyArray<{ upTo: number; color: number }> = [
  { upTo: 0.15, color: 0x6b0f1a },
  { upTo: 0.35, color: 0xd12d2d },
  { upTo: 0.65, color: 0xe0b020 },
  { upTo: 1, color: 0x3fbf50 },
];

/** How full a bar is, as a fraction of 1, safe against a zero maximum. */
export function healthFraction(hp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

/** Green, yellow, red, then dark red, as a bar empties. */
export function healthBarColor(fraction: number): number {
  for (const stop of HEALTH_BAR_STOPS) {
    if (fraction <= stop.upTo) return stop.color;
  }
  return HEALTH_BAR_STOPS[HEALTH_BAR_STOPS.length - 1]!.color;
}

/**
 * Filled width in whole world pixels.
 *
 * Rounded up while any health remains, so the last hit point is always a visible
 * sliver rather than rounding away into an empty bar somebody is still standing
 * behind. Exactly zero only when they are dead — and a dead body is off the
 * board, so in practice that width is never drawn.
 */
export function healthBarFillPx(fraction: number, width: number): number {
  if (fraction <= 0) return 0;
  return Math.max(1, Math.ceil(fraction * width));
}
