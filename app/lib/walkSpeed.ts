/**
 * How fast a body walks, once everything with an opinion has had one.
 *
 * A module of its own, and a small one, because three things that must not
 * import each other all need the same band: a status carries a percentage
 * (`./status`), a tile carries one (`./types`), and the arithmetic that turns
 * the sum into milliseconds lives beside the movement rules
 * (`../game/movement`). Anywhere else it would be a cycle or a second copy of
 * the same two numbers.
 *
 * **Percentages, summed, and divided once.** Every source says how much quicker
 * or slower it makes a body, and the sum is applied to the pace the body is
 * authored at. Summing rather than multiplying is what the rest of the game
 * already does with modifiers — see `../game/statuses`'s `withStatusModifiers` —
 * and it is the behaviour an author can predict: two chills that each say `-30`
 * come to `-60` rather than to `-51`.
 */

/**
 * The slowest anything can be made to walk, as a percentage of its own pace.
 *
 * **Not -100, and that is the whole reason there is a floor at all.** A body at
 * no speed does not take a slow step, it takes no step ever: the duration is a
 * divisor, and nothing in the game clears a condition that stopped a body from
 * walking out of it. A tenth of the pace is a bog nobody enjoys and everybody
 * escapes, which is the worst a piece of authored content should be able to do.
 */
export const MIN_WALK_SPEED_PERCENT = -90;

/**
 * The quickest, on the same terms.
 *
 * Five times the authored pace, which is past anything worth authoring and
 * short of the range where a step stops being something a viewer can see
 * happen. Its job is to make a typo'd extra digit read as malformed rather than
 * as a body that crosses a room between two frames.
 */
export const MAX_WALK_SPEED_PERCENT = 400;

/**
 * Shortest a step may take, in milliseconds.
 *
 * A floor on the *result* rather than a second opinion about the band above:
 * the duration is the denominator of the fraction a body is drawn at, and a
 * zero would be a division by zero on both sides of the wire. Anything this
 * short already lands inside one tick, so what it bounds is the arithmetic and
 * not the animation.
 */
const MIN_WALK_DURATION_MS = 1;

/** The sum of every source, held inside the band. */
export function clampWalkSpeedPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(
    MIN_WALK_SPEED_PERCENT,
    Math.min(MAX_WALK_SPEED_PERCENT, percent),
  );
}

/**
 * A body's authored pace, moved by everything slowing or hurrying it.
 *
 * The percentage is a change in **speed**, so it divides rather than multiplies
 * the duration: `-50` is half the speed and therefore twice the milliseconds,
 * and `100` is twice the speed and half of them. Authoring it the other way
 * round — a percentage of the duration — would make "50% slower" and "50%
 * faster" cancel out to something other than where they started, which is not
 * what either phrase means.
 *
 * Rounded, because a step is timed in whole milliseconds on both sides and two
 * ends rounding differently is exactly the drift this arithmetic exists to
 * avoid.
 */
export function walkDurationFrom(baseMs: number, speedPercent: number): number {
  const speed = 1 + clampWalkSpeedPercent(speedPercent) / 100;
  return Math.max(MIN_WALK_DURATION_MS, Math.round(baseMs / speed));
}
