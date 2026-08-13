import { useCallback, useSyncExternalStore } from "react";

/**
 * A media query as React state.
 *
 * `useSyncExternalStore` rather than an effect plus state: the query is already
 * an external store with a subscription, and going through an effect means one
 * render at the wrong answer before it is corrected — visible as a layout that
 * flips on mount every single time.
 *
 * **Server-rendered as false**, always, whatever the query. The server cannot
 * know the shape of the window or the kind of pointer, so every caller has to
 * pick a phrasing whose false answer is the safer one to be briefly wrong
 * about. That is a real constraint on how a query is written and not an
 * incidental detail: ask "is this narrow" rather than "is this wide".
 */
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
