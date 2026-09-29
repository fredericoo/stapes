import { useCallback, useEffect, useRef, useState } from "react";

export const DWELL_MS = 400;

export function useDwell(enabled: boolean): {
  dwelling: boolean;
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
