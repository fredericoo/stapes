import { useSyncExternalStore } from "react";
import { isTypingTarget } from "../game/heldDirections";

/**
 * Any pointer that can aim precisely: a mouse or a trackpad, on its own or
 * beside a touch screen. `any-pointer` rather than `pointer`, so a touch laptop
 * — whose primary pointer may be the screen — still counts.
 */
const FINE_POINTER = "(any-pointer: fine)";

/** Whether a hardware key has been pressed on this page. Only ever goes true. */
let keyPressed = false;
const listeners = new Set<() => void>();

/**
 * A key pressed anywhere but a text field.
 *
 * An on-screen keyboard only sends keys to the field it was opened for, so a
 * key that lands anywhere else came from a keyboard somebody plugged in or
 * paired. Listened for in the capture phase, so a handler further down that
 * stops the event cannot hide it.
 */
function onKeyDown(e: KeyboardEvent) {
  if (keyPressed || isTypingTarget(e.target)) return;
  keyPressed = true;
  for (const notify of listeners) notify();
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(FINE_POINTER);
  media.addEventListener("change", onChange);
  listeners.add(onChange);
  if (listeners.size === 1) window.addEventListener("keydown", onKeyDown, true);
  return () => {
    media.removeEventListener("change", onChange);
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener("keydown", onKeyDown, true);
  };
}

function snapshot(): boolean {
  return keyPressed || window.matchMedia(FINE_POINTER).matches;
}

/**
 * Is there probably a keyboard to press the drawn shortcuts with?
 *
 * **A browser cannot say whether a keyboard is attached**, so this is a guess
 * that corrects itself. It starts from the pointer: a mouse or a trackpad
 * almost always comes with keys, and a phone has neither. Then the first key
 * pressed outside a text field settles it — see {@link onKeyDown} — which is
 * how a phone or tablet with a paired keyboard gets its hints: the player
 * walks with WASD once and they appear.
 *
 * Never goes back to false. A touch on a laptop's screen says nothing about
 * whether its keyboard went anywhere, and hints that flickered off whenever a
 * finger touched the glass would be worse than hints left on.
 *
 * Only decides what is *drawn*. The keys themselves are bound either way,
 * because a binding with no keyboard behind it is never pressed.
 */
export function useKeyboardLikely(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
