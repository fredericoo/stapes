/**
 * How much health a bar is showing, and what colour that makes it.
 *
 * Kept apart from the renderer because it is arithmetic with no DOM in it,
 * which is also the only way the thresholds are assertable: "is it red yet" is a
 * question about a number, and answering it by taking a screenshot is how a
 * ramp quietly stops matching what anybody said it did.
 *
 * Colours are CSS strings because the bar is an element in the world-label
 * layer rather than a quad in the scene — see `./textLabels`. That puts it in
 * the same flex column as the name, so the two can never print through each
 * other, and lets the name be tinted to match it.
 */

/**
 * How wide the track is, counted in the font's own pixels.
 *
 * The bar is measured in *bricks* — `--world-label-brick`, one pixel of the
 * label font — rather than in screen pixels, and that is the whole point. A
 * hairline border and a fill that slides by fractions of a pixel are things the
 * type beside it cannot do, so a bar built that way reads as a widget from
 * another program pasted over the game. It is most obvious on a small screen,
 * where the world is zoomed out and the text is at its coarsest while the bar
 * stays razor sharp.
 *
 * So the bar follows the text, never the other way round: every edge it has
 * lands on the grid the letters land on, and the fill steps a whole brick at a
 * time like a bar drawn in pixel art would.
 */
export const HEALTH_BAR_BRICKS = 24;

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
 * Filled length in whole bricks.
 *
 * Two roundings that pull opposite ways, and both are about not lying:
 *
 * - **Anything above zero keeps at least one brick.** A creature on its last hit
 *   point out of five hundred is one you can still kill, and an empty bar says
 *   the opposite.
 * - **Anything below full loses at least one.** A bar only appears once
 *   something has been taken off, so a track that rounded up to completely full
 *   would be a bar whose whole reason for being on screen is invisible.
 */
export function healthBarFillBricks(fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return HEALTH_BAR_BRICKS;
  const bricks = Math.round(fraction * HEALTH_BAR_BRICKS);
  return Math.min(HEALTH_BAR_BRICKS - 1, Math.max(1, bricks));
}
