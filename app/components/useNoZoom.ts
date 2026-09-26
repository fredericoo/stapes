import { useEffect } from "react";

const DOUBLE_TAP_MS = 300;

const DOUBLE_TAP_SLOP_PX = 30;

export type TouchLift = { atMs: number; x: number; y: number };

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

const WEBKIT_GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

/**
 * `touch-action` alone does not stop every zoom gesture. A pinch is stopped by
 * refusing the second finger a default action, WebKit reports its own
 * two-finger gesture as `gesture*` events instead of touches, and iOS's
 * double-tap-and-hold magnifier ignores `touch-action` entirely, so its second
 * tap is cancelled here by hand.
 */
export function useNoZoom(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    const cancel = (event: Event) => event.preventDefault();

    let lastLift: TouchLift | null = null;

    const onTouchStart = (event: TouchEvent) => {
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

    /**
     * Registered with `{ passive: false }` so `preventDefault` actually cancels
     * the gesture. React registers touch listeners passively, which is why
     * these are raw `addEventListener` calls instead of JSX handlers.
     */
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
