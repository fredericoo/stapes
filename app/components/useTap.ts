import { useCallback, useRef } from "react";

const TAP_SLOP_PX = 10;

const SYNTHESISED_CLICK_WINDOW_MS = 500;

function swallowSynthesisedClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  document.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => {
    document.removeEventListener("click", swallow, { capture: true });
  }, SYNTHESISED_CLICK_WINDOW_MS);
}

export type TouchPress = { pointerId: number; x: number; y: number };

export type PointerLift = {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
};

export function completesTap(
  began: TouchPress | null,
  lift: PointerLift,
  slopPx: number = TAP_SLOP_PX,
): boolean {
  if (lift.pointerType !== "touch") return false;
  if (!began || began.pointerId !== lift.pointerId) return false;
  return Math.hypot(lift.x - began.x, lift.y - began.y) <= slopPx;
}

export type TapProps = {
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel: React.PointerEventHandler<HTMLButtonElement>;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
};

export function useTap(onTap: () => void): TapProps {
  const pressed = useRef<TouchPress | null>(null);
  const run = useRef(onTap);
  run.current = onTap;

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    pressed.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    const began = pressed.current;
    pressed.current = null;
    if (
      !completesTap(began, {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        x: event.clientX,
        y: event.clientY,
      })
    ) {
      return;
    }
    swallowSynthesisedClick();
    run.current();
  }, []);

  const onPointerCancel = useCallback(() => {
    pressed.current = null;
  }, []);

  const onClick = useCallback(() => run.current(), []);

  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}
