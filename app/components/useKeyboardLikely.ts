import { useSyncExternalStore } from "react";
import { isTypingTarget } from "../game/heldDirections";

const FINE_POINTER = "(any-pointer: fine)";

let keyPressed = false;
const listeners = new Set<() => void>();

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

export function useKeyboardLikely(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
