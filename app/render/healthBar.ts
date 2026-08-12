/**
 * How much health a bar is showing, and what colour that makes it.
 *
 * Kept apart from the renderer because it is arithmetic with no DOM in it,
 * which is also the only way the thresholds are assertable: "is it red yet" is a
 * question about a number, and answering it by taking a screenshot is how a
 * ramp quietly stops matching what anybody said it did.
 *
 * Colours are CSS strings because the bar is an element in the world-label
 * layer rather than a quad in the scene — see `./textLabels`. Drawing it there
 * buys the same crispness the text has, at screen resolution instead of the
 * world's chunky pixels, and puts it in the same flex column as the name so the
 * two can never print through each other.
 */

/**
 * The ramp, worst first. Each entry claims everything at or below its fraction
 * that no earlier entry claimed, so the order here *is* the thresholds.
 *
 * Four stops rather than a gradient because the art is palettised and a smooth
 * fade would land on a handful of indistinguishable colours anyway — and because
 * a player reads "it went red" far faster than they read a hue.
 */
export const HEALTH_BAR_STOPS: ReadonlyArray<{ upTo: number; color: string }> = [
  { upTo: 0.15, color: "#6b0f1a" },
  { upTo: 0.35, color: "#d12d2d" },
  { upTo: 0.65, color: "#e0b020" },
  { upTo: 1, color: "#3fbf50" },
];

/** How full a bar is, as a fraction of 1, safe against a zero maximum. */
export function healthFraction(hp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

/** Green, yellow, red, then dark red, as a bar empties. */
export function healthBarColor(fraction: number): string {
  for (const stop of HEALTH_BAR_STOPS) {
    if (fraction <= stop.upTo) return stop.color;
  }
  return HEALTH_BAR_STOPS[HEALTH_BAR_STOPS.length - 1]!.color;
}

/**
 * How wide the filled part is, as a CSS percentage.
 *
 * Never rounds the last hit point away: anything above zero keeps at least a
 * visible sliver, because a creature on its last point out of five hundred is
 * one you can still kill and an empty bar over it says the opposite. Exactly
 * zero only means dead — and a dead body is off the board, so in practice that
 * width is never drawn.
 */
export function healthBarFillPercent(fraction: number): number {
  if (fraction <= 0) return 0;
  return Math.max(MIN_VISIBLE_FILL_PERCENT, fraction * 100);
}

/**
 * The smallest sliver a surviving creature is drawn with.
 *
 * Five percent of a bar around forty pixels wide is two pixels — narrow enough
 * to read as "almost gone", wide enough to be a bar rather than a rounding
 * artefact of the border.
 */
const MIN_VISIBLE_FILL_PERCENT = 5;
