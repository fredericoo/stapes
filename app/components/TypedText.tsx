import { useLayoutEffect, useRef } from "react";

const TYPED_CHARS_PER_SECOND = 100;
const MS_PER_SECOND = 1000;

/**
 * Writes the two text nodes itself from an animation frame rather than
 * re-rendering per character. The untyped rest stays in the layout, invisible,
 * so the line wraps where it will end up and nothing below it moves.
 */
export function TypedText({
  text,
  typing,
  onTyped,
}: {
  text: string;
  typing: boolean;
  onTyped: () => void;
}) {
  const typedRef = useRef<HTMLSpanElement>(null);
  const restRef = useRef<HTMLSpanElement>(null);
  const onTypedRef = useRef(onTyped);
  onTypedRef.current = onTyped;

  useLayoutEffect(() => {
    const typed = typedRef.current;
    const rest = restRef.current;
    if (!typing || !typed || !rest) return;
    const chars = Array.from(text);
    typed.textContent = "";
    rest.textContent = text;
    let shown = 0;
    let startMs: number | null = null;
    let frame = 0;
    const tick = (nowMs: number) => {
      startMs ??= nowMs;
      const due = Math.floor(((nowMs - startMs) * TYPED_CHARS_PER_SECOND) / MS_PER_SECOND);
      const next = Math.min(chars.length, due);
      if (next !== shown) {
        shown = next;
        typed.textContent = chars.slice(0, shown).join("");
        rest.textContent = chars.slice(shown).join("");
      }
      if (shown >= chars.length) return onTypedRef.current();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, typing]);

  if (!typing) return <span aria-hidden="true">{text}</span>;
  /**
   * Keyed apart from the finished line so React replaces this subtree instead
   * of reconciling text nodes it does not own.
   */
  return (
    <span key="typing" aria-hidden="true">
      <span ref={typedRef} />
      <span ref={restRef} className="invisible" />
    </span>
  );
}
