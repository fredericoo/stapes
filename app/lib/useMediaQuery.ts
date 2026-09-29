import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const COARSE_POINTER = "(pointer: coarse)";

export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER);
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION);
}
