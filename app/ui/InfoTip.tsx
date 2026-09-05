import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

/**
 * A small `i` that opens the engine's side of the story.
 *
 * The label beside it says what a field *is*; this says how the simulation
 * reads it — the unit, the clamp, the thing it interacts with two tabs away.
 * That used to be a paragraph under every control, and a panel of forty
 * paragraphs is a panel nobody reads. Held here it costs one glyph, and it is
 * there for the author who wants it.
 *
 * A real button rather than a span, so it can be reached and opened from the
 * keyboard. It is not a `title`: those take a second to appear and vanish on
 * the first twitch of the pointer.
 */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip
      side="top"
      content={
        <span className="block max-w-72 font-normal normal-case leading-snug">
          {children}
        </span>
      }
    >
      <button
        type="button"
        aria-label="More about this"
        className={[
          "inline-flex size-4 shrink-0 items-center justify-center",
          "border-2 border-border bg-panel font-mono text-[10px] leading-none text-muted",
          "hover:bg-ink hover:text-paper",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        ].join(" ")}
      >
        i
      </button>
    </Tooltip>
  );
}
