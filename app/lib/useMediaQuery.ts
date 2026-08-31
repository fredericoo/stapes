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

/** A pointer you cannot aim precisely, and that has no hover: a finger. */
const COARSE_POINTER = "(pointer: coarse)";

/**
 * Is the primary input a finger?
 *
 * The one place the interface asks "phone or desktop", and it asks it about the
 * *input device* rather than the window's shape on purpose: a desktop window
 * dragged narrow is still played with a keyboard and a mouse, and it still has
 * the hover that half these decisions turn on.
 *
 * It decides whether the on-screen arrows are drawn at all, and it decides the
 * things that follow from having no hover — a container captioning its squares
 * (`../components/ContainerPanel`), a square answering a held finger with the
 * description a mouse would have got for free (`../components/ItemSlot`).
 *
 * Server-rendered as false: the server cannot know, and a keyboard layout that
 * gains a pad on hydration is a smaller lie than a pad that vanishes.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER);
}
