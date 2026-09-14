import { useCallback, useEffect, useRef, useState } from "react";
import type { Direction } from "../lib/types";

/**
 * On-screen arrows, for playing without a keyboard.
 *
 * A disc with four arrows on it rather than four separate buttons: every point
 * in the pad belongs to some direction, so there is nothing to miss between the
 * arrows. Direction comes from where the thumb is relative to the centre, not
 * from which element it landed on, which is also what makes sliding from one
 * quadrant to the next steer rather than stop.
 *
 * **It is drawn as one round thing because it is one thing.** It used to be four
 * squares, and people tapped them — once each, like keys — when the control they
 * were holding had always been a stick you push. Four buttons is a picture of
 * four buttons, however the pointer is actually read, and the picture is what a
 * thumb believes. A ring with a knob in the middle that follows the finger is a
 * picture of the thing it really is, and the knob moving is the part that says
 * "keep pushing" without a word of instruction.
 *
 * The four buttons are still here for their names and for the keyboard, but they
 * take no pointer events — the pad reads the geometry itself.
 */

/** The smallest touch target WCAG 2.5.5 will accept. */
const MIN_TOUCH_TARGET_PX = 44;

/**
 * Side of the pad's touch area, and the disc is inscribed in it.
 *
 * **One size, and it is the accessible minimum rather than a comfortable
 * maximum.** Two targets across is what a d-pad is — west and east have to be
 * separately hittable, and so do north and south — so this is as small as the
 * control is allowed to be, and there is nothing a larger one buys. A thumb
 * steering it is resting on it, not aiming at it: direction comes from where the
 * finger is relative to the centre, and a pointer captured at touch-down keeps
 * steering even when it slides off the edge, so the disc does not have to be big
 * enough to contain the gesture.
 *
 */
export const PAD_SIZE_PX = MIN_TOUCH_TARGET_PX * 3;

/**
 * How far out from the centre each arrow sits, as a share of the disc's radius.
 *
 * Out near the rim, where the thumb travels, rather than tight around the knob:
 * the arrows are the labels on the edge of a dial and the knob is what you move,
 * and the gap between them is what says which is which.
 */
const ARROW_RADIUS_RATIO = 0.72;

/**
 * How far the knob's centre slides towards the direction being steered, as a
 * share of the disc's radius.
 *
 * Short of the arrows on purpose, and it is the *edge* that has to clear them
 * rather than the centre: travel plus half the knob's width has to come out
 * under {@link ARROW_RADIUS_RATIO}, or a knob pushed east parks on top of the
 * east arrow and hides the one glyph that is currently telling the truth.
 */
const KNOB_TRAVEL_RATIO = 0.22;

/** The knob's diameter, as a share of the disc's. See the travel above. */
const KNOB_SIZE_RATIO = 0.34;

/**
 * A thumb resting near the middle should not steer.
 *
 * A length rather than a ratio, now that the pad is one size: there is nothing
 * left for it to be a share *of*. It is the same share of the radius the fluid
 * pad had at its most comfortable — sixteen pixels of a 176px pad, eight of an
 * 88px one — so halving the disc did not double how far you have to push it
 * before it answers.
 */
const DEAD_ZONE_PX = 8;

/**
 * The direction a point means, measured from the pad's centre — or null when it
 * is too close to the middle to mean anything.
 *
 * The diagonals are the borders, so the disc is quartered by them and each
 * quarter reaches out to the corner of the touch area behind it: a tap that
 * misses the drawn circle still steers the way it was aimed.
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

/**
 * Where each arrow sits on the disc, as a unit vector from the centre.
 *
 * Stated as geometry rather than as grid cells because that is what the pad now
 * is: the same two numbers place the glyph and displace the knob, so the arrow a
 * thumb is heading for and the knob it is dragging can never disagree about
 * which way is north.
 */
const ARROWS: {
  direction: Direction;
  label: string;
  glyph: string;
  dx: number;
  dy: number;
}[] = [
  { direction: "n", label: "Walk north", glyph: "▲", dx: 0, dy: -1 },
  { direction: "e", label: "Walk east", glyph: "▶", dx: 1, dy: 0 },
  { direction: "s", label: "Walk south", glyph: "▼", dx: 0, dy: 1 },
  { direction: "w", label: "Walk west", glyph: "◀", dx: -1, dy: 0 },
];

/** Where a thing sits on the disc, as CSS percentages from the top left. */
function placeOnDisc(dx: number, dy: number, radiusRatio: number) {
  return {
    left: `${50 + dx * radiusRatio * 50}%`,
    top: `${50 + dy * radiusRatio * 50}%`,
  };
}

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

  /** Which way the knob is being pushed, or nothing while it rests. */
  const steered = ARROWS.find((arrow) => arrow.direction === active) ?? null;

  const steerToPoint = (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    steerTo(
      directionAt(
        clientX - (rect.left + rect.width / 2),
        clientY - (rect.top + rect.height / 2),
        DEAD_ZONE_PX,
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
      // One fixed square. It used to be fluid between two bounds, which meant
      // the row it sat in had to be measured before either could be laid out,
      // and a column too short to hold the result simply overflowed — the pad's
      // height came from its width, so a vertical squeeze could not reach it.
      // @see PAD_SIZE_PX
      className="relative shrink-0 touch-none select-none"
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
        // First finger on the pad owns it until it lifts. Without this a second
        // one landing on the pad took the slot over, and *its* release stopped
        // the walk while the finger actually steering was still down.
        if (pointerRef.current !== null) return;
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
      {/* The disc. One ring around the whole pad rather than four outlines,
          because there are not four of anything here. */}
      <div className="pad-disc absolute inset-0 border-2 border-paper/40 bg-ink" />

      {/* The knob, which is the part that says this is a thing you push. It
          rides towards whatever is being steered and sits in the middle when
          nothing is — no transition, because the finger is already the animation
          and a knob easing in behind it would read as lag. */}
      <div
        aria-hidden="true"
        className={[
          "pad-knob pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 border-2",
          active ? "border-paper bg-paper" : "border-paper/40 bg-paper/10",
        ].join(" ")}
        style={{
          width: `${KNOB_SIZE_RATIO * 100}%`,
          height: `${KNOB_SIZE_RATIO * 100}%`,
          ...placeOnDisc(steered?.dx ?? 0, steered?.dy ?? 0, KNOB_TRAVEL_RATIO),
        }}
      />

      {ARROWS.map(({ direction, label, glyph, dx, dy }) => (
        <button
          key={direction}
          type="button"
          aria-label={label}
          aria-pressed={active === direction}
          // The pad reads the pointer itself; these stay for the keyboard and
          // for anything reading the page out loud. Which is also why they carry
          // no box: a control that is one round thing must not sprout four
          // outlines at the moment somebody tabs into it.
          className={[
            "pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center text-lg leading-none",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            active === direction ? "text-paper" : "text-paper/50",
          ].join(" ")}
          style={placeOnDisc(dx, dy, ARROW_RADIUS_RATIO)}
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
          <span aria-hidden="true">{glyph}</span>
        </button>
      ))}
    </div>
  );
}
