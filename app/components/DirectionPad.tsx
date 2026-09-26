import { useCallback, useEffect, useRef, useState } from "react";
import type { Direction } from "../lib/types";

const MIN_TOUCH_TARGET_PX = 44;

export const PAD_SIZE_PX = MIN_TOUCH_TARGET_PX * 3;

const ARROW_RADIUS_RATIO = 0.72;

const KNOB_TRAVEL_RATIO = 0.22;

const KNOB_SIZE_RATIO = 0.34;

const DEAD_ZONE_PX = 8;

export function directionAt(
  dx: number,
  dy: number,
  deadZonePx: number = DEAD_ZONE_PX,
): Direction | null {
  if (Math.hypot(dx, dy) < deadZonePx) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

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
  const activeRef = useRef<Direction | null>(null);
  const pointerRef = useRef<number | null>(null);

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

    const cancelNativeGesture = (event: TouchEvent) => event.preventDefault();
    pad.addEventListener("touchstart", cancelNativeGesture, { passive: false });
    pad.addEventListener("touchmove", cancelNativeGesture, { passive: false });
    return () => {
      pad.removeEventListener("touchstart", cancelNativeGesture);
      pad.removeEventListener("touchmove", cancelNativeGesture);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (activeRef.current) onRelease(activeRef.current);
    };
  }, [onRelease]);

  return (
    <div
      ref={padRef}
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
        if (pointerRef.current !== null) return;
        pointerRef.current = e.pointerId;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
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
      <div className="pad-disc absolute inset-0 border-2 border-paper/40 bg-ink" />

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
