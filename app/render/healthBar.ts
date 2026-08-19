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
 * How many steps a fill is rounded to when nothing constrains the track.
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
 *
 * This is no longer the width of the bar over a head — that is a cell wide now,
 * so it changes with the zoom; see {@link healthBarTrackBricks}. What is left is
 * the number a track falls back to when it is not being fitted to anything: the
 * row in the interaction list, whose bar is a percentage of a column it does not
 * choose the width of, and which uses this only for the rounding.
 */
export const HEALTH_BAR_FILL_STEPS = 24;

/**
 * The border `.world-label__bar` is drawn with, per side, in bricks.
 *
 * Stated here because the track is sized to a cell *including* its border — a
 * bar that fits a cell only on the inside is a bar two bricks wider than a cell,
 * which is the overlap this is about. Must match the `border` in `app/app.css`.
 */
const TRACK_BORDER_BRICKS = 1;

/**
 * The shortest track still worth drawing, in bricks.
 *
 * Not a readability floor — a guard against arithmetic. A cell is only about
 * seven bricks across at the smallest window anybody plays in, and the border
 * eats two of those; a pane smaller than the game is really meant for would
 * otherwise ask for a track of zero bricks or fewer, which is a bar that has
 * quietly stopped reporting anything at all.
 */
const MIN_TRACK_BRICKS = 4;

/**
 * How wide the track over a head should be: one cell, in whole bricks.
 *
 * The bar used to be a fixed 24 bricks whatever the zoom, which is a width that
 * happens to equal a cell at one particular window size and is wrong either side
 * of it — on a small screen it was two cells wide, so two creatures standing
 * side by side had bars lying across each other and neither reading belonged to
 * anybody in particular. Since telling those two apart is most of what a bar
 * over a head is for, the width follows the cell.
 *
 * **Rounded down, and the border counts.** A cell in CSS pixels is
 * `CELL_SIZE * cssScale` and is fractional almost always; taking the whole
 * bricks that fit inside it keeps every edge on the grid the letters sit on, and
 * keeps the bar no wider than the cell it belongs to — which is the promise that
 * makes two neighbours legible. A bar a brick or two narrower than its cell is a
 * gap between neighbours; a bar rounded *up* is the overlap back again.
 *
 * Two creatures mid-step can still be less than a cell apart on screen, since
 * bodies move smoothly between cells. That is a moment during a walk rather than
 * the standing case, and no width fixes it.
 */
export function healthBarTrackBricks(
  cellCssPx: number,
  brickCssPx: number,
): number {
  if (!(brickCssPx > 0)) return MIN_TRACK_BRICKS;
  const bricksAcrossCell = Math.floor(cellCssPx / brickCssPx);
  return Math.max(MIN_TRACK_BRICKS, bricksAcrossCell - TRACK_BORDER_BRICKS * 2);
}

/**
 * How many bricks of length buy one brick of thickness.
 *
 * The bar is a shape before it is a reading: a long thin rule reads as a gauge,
 * and something close to square reads as a block of colour with no length to
 * judge. Since the track is now a cell wide and a cell is much narrower on a
 * phone than on a monitor, a fixed thickness cannot be right at both — at the
 * small end a four-brick fill in a six-brick track is very nearly a square.
 *
 * A fifth is the ratio the desktop bar already had and looked right at, so this
 * is the number that keeps that case exactly where it was while the small end
 * thins out to match.
 */
const TRACK_BRICKS_PER_FILL_BRICK = 5;

/**
 * Thickness never leaves this range, whatever the ratio asks for.
 *
 * Below two bricks the fill stops carrying its colour — which is the entire job,
 * since a player reads "it went red" long before they read a length — and a
 * single brick reads as a rule drawn under the name rather than as a gauge.
 * Above four it starts to look like a second body part rather than chrome, and
 * it is already thicker than the strokes of the type beside it.
 */
const MIN_FILL_HEIGHT_BRICKS = 2;
const MAX_FILL_HEIGHT_BRICKS = 4;

/**
 * How thick the fill in a track of this length should be, in bricks.
 *
 * In proportion rather than at a fixed size, so a bar keeps its shape as the
 * window changes it — see {@link healthBarTrackBricks}, which is where the
 * length comes from. Clamped at both ends: the ratio alone would give a phone a
 * one-brick hairline and a very wide monitor a slab.
 */
export function healthBarFillHeightBricks(trackBricks: number): number {
  const wanted = Math.round(trackBricks / TRACK_BRICKS_PER_FILL_BRICK);
  return Math.max(
    MIN_FILL_HEIGHT_BRICKS,
    Math.min(MAX_FILL_HEIGHT_BRICKS, wanted),
  );
}

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
 * Filled length in whole bricks, out of a track of `trackBricks`.
 *
 * The track's length is an argument because it is no longer one number: a bar
 * over a head is as wide as a cell and so changes with the zoom, while the row
 * in the interaction list is a percentage of a column. Both round the same way,
 * which is what keeps a creature going red on the list at the same moment it
 * goes red in the world.
 *
 * Two roundings that pull opposite ways, and both are about not lying:
 *
 * - **Anything above zero keeps at least one brick.** A creature on its last hit
 *   point out of five hundred is one you can still kill, and an empty bar says
 *   the opposite.
 * - **Anything below full loses at least one.** Every battler carries a bar now,
 *   full or not, so a completely full track is the one reading that means
 *   "untouched" — and a scratch that rounded up to it would be the bar saying
 *   nothing had happened.
 */
export function healthBarFillBricks(
  fraction: number,
  trackBricks: number = HEALTH_BAR_FILL_STEPS,
): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return trackBricks;
  const bricks = Math.round(fraction * trackBricks);
  return Math.min(trackBricks - 1, Math.max(1, bricks));
}
