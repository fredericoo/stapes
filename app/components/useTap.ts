import { useCallback, useRef } from "react";

/**
 * A press that works while another finger is already down.
 *
 * `click` on a touch screen is not an event the hardware produces — it is
 * synthesised from a touch afterwards, and iOS synthesises it only for a
 * *single* finger. Apple's own event guide is explicit that a two-finger
 * gesture generates no mouse events at all, which on this page means every
 * `onClick` control is dead for as long as a thumb is steering the d-pad. The
 * two surfaces that kept working while walking — the pad and the canvas — are
 * exactly the two that never asked for a click.
 *
 * So a touch press is read from the pointer events themselves, which arrive per
 * finger regardless of what the other one is doing, and `click` is left to the
 * inputs that genuinely have one: a mouse, and a keyboard pressing Enter on a
 * focused button.
 */

/**
 * How far a finger may travel between landing and lifting and still have meant
 * a press.
 *
 * There has to be *some* slack — a thumb never lifts from exactly where it
 * landed — but the number is really here for the interaction list, which
 * scrolls: without it, flicking the list would fire whichever row the finger
 * started on. Ten pixels is under the width of a fingertip and well under the
 * height of a row.
 */
const TAP_SLOP_PX = 10;

/**
 * How long a synthesised click may take to arrive before it is somebody else's.
 *
 * Generous on purpose. A browser that still has the legacy 300ms double-tap
 * wait sends its click most of a second after the finger left, and the cost of
 * guessing long is nil: on a touch screen there is no *other* click coming in
 * that window for this to eat.
 */
const SYNTHESISED_CLICK_WINDOW_MS = 500;

/**
 * Swallow the click a touch press is about to echo, wherever it lands.
 *
 * On the document and in the capture phase rather than on the button, because
 * the press has already run by the time this is armed and the page may no
 * longer look the way it did: opening a panel or re-ordering the list moves
 * whatever is under the finger, and the echo would land on that instead — a
 * press the player never made. Nothing may see the click, so it is stopped
 * before it reaches anything.
 */
function swallowSynthesisedClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  document.addEventListener("click", swallow, { capture: true, once: true });
  // Disarmed if no echo ever comes — some browsers send none — so a real click
  // later on is never the one that gets eaten. A no-op if `once` already fired.
  window.setTimeout(() => {
    document.removeEventListener("click", swallow, { capture: true });
  }, SYNTHESISED_CLICK_WINDOW_MS);
}

/** A finger that has landed on a button and not yet lifted. */
export type TouchPress = { pointerId: number; x: number; y: number };

/** A pointer leaving the screen, or the mouse letting go. */
export type PointerLift = {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
};

/**
 * Does this lift mean the button was pressed?
 *
 * Pulled out whole because it is the part with the rules in it and none of the
 * React around it: three separate reasons to say no, each of them a gesture
 * somebody will actually make.
 */
export function completesTap(
  began: TouchPress | null,
  lift: PointerLift,
  slopPx: number = TAP_SLOP_PX,
): boolean {
  // Every other kind of pointer has a real click behind it, and letting one
  // through here would run the press twice.
  if (lift.pointerType !== "touch") return false;
  // A lift belonging to a press that started somewhere else. Touch gives the
  // pressed element implicit capture, so this is how a drag that merely *ended*
  // over a button is told apart from one that began on it — and how a second
  // finger is stopped from releasing the first one's press.
  if (!began || began.pointerId !== lift.pointerId) return false;
  return Math.hypot(lift.x - began.x, lift.y - began.y) <= slopPx;
}

/** Handlers to spread onto a button, in place of `onClick`. */
export type TapProps = {
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel: React.PointerEventHandler<HTMLButtonElement>;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
};

export function useTap(onTap: () => void): TapProps {
  /**
   * Where and by which finger this button was pressed, or null for not pressed.
   *
   * The id is checked on the way up so a second finger landing on the same
   * button cannot release the first one's press, and the point is what the slop
   * above is measured from.
   */
  const pressed = useRef<TouchPress | null>(null);
  /**
   * What to run, read at the moment of the press rather than closed over.
   *
   * So that a caller can hand this an inline arrow — which is how every one of
   * them wants to write it — without the handlers below changing identity on
   * every render, and without five call sites each wrapping their one line in a
   * `useCallback` to avoid it.
   */
  const run = useRef(onTap);
  run.current = onTap;

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    pressed.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
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
    },
    [],
  );

  const onPointerCancel = useCallback(() => {
    pressed.current = null;
  }, []);

  const onClick = useCallback(() => run.current(), []);

  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}
