import { useLayoutEffect, useMemo, useRef } from "react";
import { dialogTextParts, pixelFontText, type DialogTextPart } from "../lib/dialogText";
import { ItemMention } from "./ItemMention";

const TYPED_CHARS_PER_SECOND = 100;
const MS_PER_SECOND = 1000;

/** How many characters' worth of time an item mention takes to appear. */
const MENTION_CHARS = 4;

function charsOf(part: DialogTextPart): string[] | null {
  return part.kind === "text" ? Array.from(part.text) : null;
}

/**
 * A line or a label with its `{item:…}` mentions drawn as items. While
 * `typing`, it writes the text nodes itself from an animation frame rather
 * than re-rendering per character, and keeps what is not typed yet in the
 * layout but invisible, so the line wraps where it will end up.
 */
export function DialogText({
  text,
  typing = false,
  onTyped,
  focusable = true,
}: {
  text: string;
  typing?: boolean;
  onTyped?: () => void;
  focusable?: boolean;
}) {
  const parts = useMemo(() => dialogTextParts(pixelFontText(text)), [text]);
  const rootRef = useRef<HTMLSpanElement>(null);
  const onTypedRef = useRef(onTyped);
  onTypedRef.current = onTyped;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!typing || !root) return;
    const nodes = [...root.children] as HTMLElement[];
    const chars = parts.map(charsOf);
    const total = chars.reduce((sum, list) => sum + (list?.length ?? MENTION_CHARS), 0);

    const paint = (shown: number) => {
      let left = shown;
      for (const [index, node] of nodes.entries()) {
        const list = chars[index];
        const length = list?.length ?? MENTION_CHARS;
        if (list) {
          const typed = Math.min(left, length);
          node.children[0]!.textContent = list.slice(0, typed).join("");
          node.children[1]!.textContent = list.slice(typed).join("");
        } else {
          node.style.visibility = left >= length ? "" : "hidden";
        }
        left = Math.max(0, left - length);
      }
    };

    let shown = 0;
    let startMs: number | null = null;
    let frame = 0;
    paint(0);
    const tick = (nowMs: number) => {
      startMs ??= nowMs;
      const due = Math.floor(((nowMs - startMs) * TYPED_CHARS_PER_SECOND) / MS_PER_SECOND);
      const next = Math.min(total, due);
      if (next !== shown) {
        shown = next;
        paint(shown);
      }
      if (shown >= total) return onTypedRef.current?.();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [parts, typing]);

  if (!typing) {
    return (
      <span>
        {parts.map((part, index) =>
          part.kind === "text" ? (
            <span key={index}>{part.text}</span>
          ) : (
            <ItemMention key={index} tileId={part.tileId} focusable={focusable} />
          ),
        )}
      </span>
    );
  }
  /**
   * Keyed apart from the finished line so React replaces this subtree instead
   * of reconciling text nodes it does not own.
   */
  return (
    <span key="typing" ref={rootRef}>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>
            <span />
            <span className="invisible" />
          </span>
        ) : (
          <span key={index}>
            <ItemMention tileId={part.tileId} focusable={focusable} />
          </span>
        ),
      )}
    </span>
  );
}
