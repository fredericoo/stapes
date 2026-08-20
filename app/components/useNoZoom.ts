import { useEffect } from "react";

/**
 * No zooming, for as long as the game is on screen.
 *
 * A zoomed page is not a bigger view of the world — the world is drawn to a
 * fixed square and every player sees the same amount of it, so magnifying the
 * page only crops the controls and leaves the arrows half off the screen with
 * nothing saying how to get back. Every zoom here is one somebody triggered by
 * accident while trying to walk.
 *
 * Three separate gestures reach for it and none of them is stopped by the same
 * thing, which is why this is a hook and not a CSS property:
 *
 * - **Pinch.** `touch-action` covers this wherever it is declared, but only
 *   where it is declared, and the page has chrome above the game that has no
 *   reason to carry it. Refusing the second finger a default action stops it
 *   everywhere at once.
 * - **A two-finger gesture WebKit handles itself.** It arrives as its own
 *   `gesture*` events rather than as touches to be interpreted, so nothing
 *   underneath is ever asked.
 * - **Double-tap, then drag.** iOS's magnifier. `touch-action` does *not* call
 *   this one off — see `./DirectionPad`, which learned it the hard way — and
 *   cancelling the second tap's default action is what does.
 *
 * Only ever installed for a finger. A trackpad pinch on a desktop is the
 * browser's own zoom and belongs to the reader, not to us.
 */

/** How soon after a tap a second one is still the same double-tap. */
const DOUBLE_TAP_MS = 300;

/** And how near it has to land to be aimed at the same thing. */
const DOUBLE_TAP_SLOP_PX = 30;

/** A finger leaving the screen: when, and where it was. */
export type TouchLift = { atMs: number; x: number; y: number };

/**
 * Is this finger landing the second half of a double-tap?
 *
 * Two touch sequences make one gesture, and the browser reports them
 * separately, so the only way to recognise the magnifier before it starts is to
 * remember the last lift and measure the next landing against it: soon enough
 * to be the same gesture, near enough to be aimed at the same thing.
 */
export function continuesDoubleTap(
  lastLift: TouchLift | null,
  landing: TouchLift,
  withinMs: number = DOUBLE_TAP_MS,
  slopPx: number = DOUBLE_TAP_SLOP_PX,
): boolean {
  if (!lastLift) return false;
  if (landing.atMs - lastLift.atMs >= withinMs) return false;
  return Math.hypot(landing.x - lastLift.x, landing.y - lastLift.y) < slopPx;
}

/** The two-finger zoom WebKit reports as a gesture rather than as touches. */
const WEBKIT_GESTURE_EVENTS = [
  "gesturestart",
  "gesturechange",
  "gestureend",
] as const;

export function useNoZoom(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    const cancel = (event: Event) => event.preventDefault();

    /** Where the last finger left, for {@link continuesDoubleTap} to measure. */
    let lastLift: TouchLift | null = null;

    const onTouchStart = (event: TouchEvent) => {
      // A pinch needs a second finger, so it never gets one. Cancelling the
      // default action does not stop the event being *reported* — the pointer
      // events still arrive and the controls still answer them.
      if (event.touches.length > 1) {
        event.preventDefault();
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const landing = {
        atMs: event.timeStamp,
        x: touch.clientX,
        y: touch.clientY,
      };
      if (continuesDoubleTap(lastLift, landing)) event.preventDefault();
    };

    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      lastLift = {
        atMs: event.timeStamp,
        x: touch.clientX,
        y: touch.clientY,
      };
    };

    // Non-passive throughout, since cancelling is the entire job: a passive
    // listener's `preventDefault` is ignored, and React registers touch
    // listeners passively, which is why none of this is written as JSX props.
    for (const name of WEBKIT_GESTURE_EVENTS) {
      document.addEventListener(name, cancel, { passive: false });
    }
    document.addEventListener("touchstart", onTouchStart, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      for (const name of WEBKIT_GESTURE_EVENTS) {
        document.removeEventListener(name, cancel);
      }
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [enabled]);
}
