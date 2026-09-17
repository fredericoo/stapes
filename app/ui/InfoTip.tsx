import type { ReactNode } from "react";
import { Tooltip, TooltipProvider } from "./Tooltip";

/**
 * A small `i` that says how the simulation reads a field: the unit, the clamp,
 * the thing it interacts with elsewhere. The label beside it says what the
 * field is.
 *
 * A real button rather than a span, so it can be reached and opened from the
 * keyboard. Not a `title`: those take a second to appear and vanish on the
 * first pointer movement.
 *
 * It opens with no delay, unlike every other tooltip. The delay exists for a
 * pointer crossing a toolbar on its way somewhere; nobody lands on a
 * four-pixel `i` by accident, and a wait after reaching it reads as broken.
 */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={0}>
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
    </TooltipProvider>
  );
}
