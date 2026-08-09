import { useCallback, useEffect, useRef, useState } from "react";
import type { Direction } from "../lib/types";

/**
 * On-screen arrows, for playing without a keyboard.
 *
 * A diamond split by its diagonals rather than four separate buttons: every
 * point in the pad belongs to some direction, so there is nothing to miss
 * between the arrows. Direction comes from where the thumb is relative to the
 * centre, not from which element it landed on, which is also what makes
 * sliding from one quadrant to the next steer rather than stop.
 *
 * The four buttons are the visible quadrants and the accessible names, but they
 * take no pointer events — the pad reads the geometry itself.
 */

/** Side of the pad's touch area. The diamond is inscribed in it. */
const PAD_SIZE_PX = 176;

/** Side of the inscribed square, before it is turned to sit on its point. */
const DIAMOND_SIZE_PX = Math.round(PAD_SIZE_PX / Math.SQRT2);

/** A thumb resting near the middle should not steer. */
const DEAD_ZONE_PX = 16;

/**
 * The direction a point means, measured from the pad's centre — or null when it
 * is too close to the middle to mean anything.
 *
 * The diagonals are the borders, so this is the diamond's four quadrants
 * extended out to the corners of the touch area: a tap that misses the drawn
 * shape still steers the way it was aimed.
 */
export function directionAt(
  dx: number,
  dy: number,
  deadZonePx: number = DEAD_ZONE_PX,
): Direction | null {
  if (Math.hypot(dx, dy) < deadZonePx) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

/** Grid order, which a 45° turn maps onto top / right / left / bottom. */
const QUADRANTS: { direction: Direction; label: string; glyph: string }[] = [
  { direction: "n", label: "Walk north", glyph: "▲" },
  { direction: "e", label: "Walk east", glyph: "▶" },
  { direction: "w", label: "Walk west", glyph: "◀" },
  { direction: "s", label: "Walk south", glyph: "▼" },
];

export function DirectionPad({
  onPress,
  onRelease,
}: {
  onPress: (direction: Direction) => void;
  onRelease: (direction: Direction) => void;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Direction | null>(null);
  /** Mirrors `active` for the event handlers, which must not close over state. */
  const activeRef = useRef<Direction | null>(null);
  const pointerRef = useRef<number | null>(null);

  /** Walk exactly one way at a time: taking the new one lets a drag steer. */
  const steerTo = useCallback(
    (next: Direction | null) => {
      const previous = activeRef.current;
      if (previous === next) return;
      if (previous) onRelease(previous);
      if (next) onPress(next);
      activeRef.current = next;
      setActive(next);
    },
    [onPress, onRelease],
  );

  const steerToPoint = (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    steerTo(
      directionAt(
        clientX - (rect.left + rect.width / 2),
        clientY - (rect.top + rect.height / 2),
      ),
    );
  };

  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;

    // iOS turns a double-tap-and-hold on a control into its own gesture — it
    // lifts the element and magnifies the page — and `touch-action` does not
    // call that off. Cancelling the touch's default action does. Pointer events
    // are dispatched independently and keep arriving, so the pad still steers.
    //
    // Native and non-passive because that is the only way to cancel: React
    // registers touch listeners passively, where preventDefault does nothing.
    const cancelNativeGesture = (event: TouchEvent) => event.preventDefault();
    pad.addEventListener("touchstart", cancelNativeGesture, { passive: false });
    pad.addEventListener("touchmove", cancelNativeGesture, { passive: false });
    return () => {
      pad.removeEventListener("touchstart", cancelNativeGesture);
      pad.removeEventListener("touchmove", cancelNativeGesture);
    };
  }, []);

  // Releasing on unmount rather than leaving it to the caller: a route change
  // mid-walk would otherwise leave the direction held for good.
  useEffect(() => {
    return () => {
      if (activeRef.current) onRelease(activeRef.current);
    };
  }, [onRelease]);

  return (
    <div
      ref={padRef}
      className="relative touch-none select-none"
      style={{
        width: PAD_SIZE_PX,
        height: PAD_SIZE_PX,
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        WebkitTapHighlightColor: "transparent",
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        pointerRef.current = e.pointerId;
        // Capture so a thumb that slides past the edge keeps steering, and so
        // the release comes back here wherever it happens.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // No live pointer to capture — the release will still find us.
        }
        steerToPoint(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (pointerRef.current !== e.pointerId) return;
        steerToPoint(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (pointerRef.current !== e.pointerId) return;
        pointerRef.current = null;
        steerTo(null);
      }}
      onPointerCancel={(e) => {
        if (pointerRef.current !== e.pointerId) return;
        pointerRef.current = null;
        steerTo(null);
      }}
    >
      <div
        className="absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-2 grid-rows-2 gap-px rotate-45"
        style={{ width: DIAMOND_SIZE_PX, height: DIAMOND_SIZE_PX }}
      >
        {QUADRANTS.map(({ direction, label, glyph }) => (
          <button
            key={direction}
            type="button"
            aria-label={label}
            aria-pressed={active === direction}
            // The pad reads the pointer itself; these stay for the keyboard and
            // for anything reading the page out loud.
            className={`pointer-events-none flex items-center justify-center border-2 ${
              active === direction
                ? "border-paper bg-paper text-ink"
                : "border-paper/40 bg-ink text-paper"
            }`}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              if (e.repeat) return;
              steerTo(direction);
            }}
            onKeyUp={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              steerTo(null);
            }}
            onBlur={() => {
              if (activeRef.current === direction) steerTo(null);
            }}
          >
            <span className="-rotate-45 text-lg" aria-hidden="true">
              {glyph}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
