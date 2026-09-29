import { type RefObject, useEffect, useState } from "react";

/**
 * Whether any part of the element is inside the viewport grown by `rootMargin`.
 * `initial` is the answer before the first observation, which is also what the
 * prerendered page is drawn with.
 */
export function useOnScreen(
  ref: RefObject<Element | null>,
  { rootMargin = "0px", initial = false }: { rootMargin?: string; initial?: boolean } = {},
): boolean {
  const [onScreen, setOnScreen] = useState(initial);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.at(-1)?.isIntersecting ?? false),
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  return onScreen;
}

/**
 * Turns true the first time the element comes inside the viewport grown by
 * `rootMargin`, and stays true, so media below the fold is fetched once
 * somebody is about to see it rather than on arrival.
 */
export function useNear(ref: RefObject<Element | null>, rootMargin: string): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.at(-1)?.isIntersecting) setNear(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, near]);

  return near;
}
