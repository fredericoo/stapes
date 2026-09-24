/**
 * How hard the view shakes when the viewer's own body is hurt.
 *
 * Pure, and out here rather than on the renderer for the reason `./strikeMotion`
 * is: the arithmetic is the whole of the behaviour and it wants a test, while
 * the renderer around it wants a canvas.
 *
 * **Sized by the share of health the blow took, not by the figure on it.** A 6
 * is nothing to a body with 200 health and most of a body with 10, and the
 * point of the shake is to say which of those just happened. The damage number
 * already says the figure; this says how much of you it was.
 *
 * The offset is a *drawing*, not a move: it is added to the camera the frame is
 * drawn from, and nothing that asks "what is on screen" — picking, targeting,
 * the view the walk-to plans in — sees it.
 */

/**
 * The share of the viewer's maximum health that shakes the view as hard as it
 * ever shakes.
 *
 * Half, because a single blow that takes half of you is already the one you
 * cannot take twice; scaling on to a whole bar would spend the top half of the
 * range on blows that can only land once. Below this the amplitude is linear in
 * the share, so a blow for a quarter shakes half as hard as one for half.
 */
export const FULL_SHAKE_SHARE = 0.5;

/**
 * The largest offset, in world pixels.
 *
 * Six of an eight-pixel cell: large enough that the whole board visibly jumps,
 * small enough that the tile under you is still the tile under you. At the
 * other end, a blow for under a twelfth of your health rounds to no pixels at
 * all, which is the intent — a scratch is not danger.
 */
export const MAX_SHAKE_PX = 6;

/** How long a shake takes to settle from any amplitude. */
export const SHAKE_DURATION_MS = 320;

/**
 * Two frequencies, in radians per millisecond, one per axis.
 *
 * Different and not in a simple ratio, so the path does not close into a line
 * or a circle the eye can follow; fast enough that a 320ms shake is several
 * swings rather than a single lurch.
 */
const FREQ_X = 0.071;
const FREQ_Y = 0.053;

/**
 * How hard one blow shakes the view, in world pixels, before it decays.
 *
 * Zero for a body with no health bar to take a share of, and for anything that
 * took nothing.
 */
export function shakeAmplitude(amount: number, maxHp: number | null): number {
  if (maxHp === null || maxHp <= 0 || amount <= 0) return 0;
  const share = Math.min(1, amount / maxHp / FULL_SHAKE_SHARE);
  return share * MAX_SHAKE_PX;
}

/**
 * How much of a shake is left, 1 at the blow and 0 once it has settled.
 *
 * Squared rather than linear, so the jolt is at the start and the tail is
 * short: a linear fade spends as long wobbling at half strength as it does
 * near full, and reads as the ground being unsteady rather than as being hit.
 */
export function shakeEnvelope(elapsedMs: number): number {
  const t = Math.min(1, Math.max(0, elapsedMs / SHAKE_DURATION_MS));
  return (1 - t) * (1 - t);
}

/**
 * The shake in progress, if any.
 *
 * Holds one amplitude and when it started rather than a list of blows. A second
 * blow while the first is still settling adds its amplitude to what is left of
 * the first and starts the decay again, so three quick blows for a fifth each
 * shake harder than one — which is what three quick blows are — without the
 * total ever passing {@link MAX_SHAKE_PX}.
 */
export class ScreenShake {
  private amplitude = 0;
  private startedMs = 0;

  /** Add a blow of this amplitude, at this moment. */
  hit(amplitude: number, nowMs: number) {
    if (amplitude <= 0) return;
    const left = this.amplitude * shakeEnvelope(nowMs - this.startedMs);
    this.amplitude = Math.min(MAX_SHAKE_PX, left + amplitude);
    this.startedMs = nowMs;
  }

  /**
   * World-pixel offset for the camera at this moment.
   *
   * Rounded, for the reason `./strikeMotion` rounds: a frame drawn from half a
   * pixel is a frame whose every edge is soft.
   */
  offset(nowMs: number): { x: number; y: number } {
    if (this.amplitude === 0) return { x: 0, y: 0 };
    const elapsed = nowMs - this.startedMs;
    if (elapsed >= SHAKE_DURATION_MS) {
      this.amplitude = 0;
      return { x: 0, y: 0 };
    }
    const reach = this.amplitude * shakeEnvelope(elapsed);
    return {
      // `+ 0` turns the -0 a rounded negative fraction gives into a 0.
      x: Math.round(reach * Math.sin(elapsed * FREQ_X)) + 0,
      // Cosine, so the first frame after a blow is already a full jolt on one
      // axis rather than starting from rest on both.
      y: Math.round(reach * Math.cos(elapsed * FREQ_Y)) + 0,
    };
  }
}
