import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long a finger has to rest on something before it is asking about it.
 *
 * Long enough that a tap never trips it — a tap is about a tenth of a second and
 * this is four — and short enough not to feel like waiting. It also clears the
 * six-pixel drag threshold in practice: a thumb on its way somewhere else has
 * moved further than that long before this is up.
 */
export const DWELL_MS = 400;

/**
 * A held finger, as a boolean.
 *
 * The thumb's version of hovering. A mouse gets a description by resting on
 * something without clicking; a touchscreen has no such gesture, so a press held
 * past {@link DWELL_MS} stands in for it. Two surfaces use it — an item slot and
 * a trade offer in a conversation — and this is the timer they share.
 *
 * Only ever true on a coarse pointer, which the caller decides. A mouse held
 * down on a slot is the start of a drag, and it has hover for the asking.
 *
 * This owns the timer and the flag and nothing else. `../components/ItemSlot`
 * runs its own copy because its press has two other jobs — starting a drag, and
 * swallowing the click that ends a hold — and neither belongs to anything that
 * is merely being read.
 */
export function useDwell(enabled: boolean): {
  dwelling: boolean;
  /** Spread onto the element being asked about. */
  handlers: {
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
  };
} {
  const [dwelling, setDwelling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const end = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDwelling(false);
  }, []);

  const start = useCallback(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setDwelling(true);
    }, DWELL_MS);
  }, [enabled]);

  // An element taken off the screen mid-hold — a conversation ending under the
  // finger — must not leave its timer running against a component that is gone.
  useEffect(() => end, [end]);

  return {
    dwelling,
    handlers: {
      onPointerDown: start,
      onPointerUp: end,
      onPointerCancel: end,
      onPointerLeave: end,
    },
  };
}
