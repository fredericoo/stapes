import type { ReactNode } from "react";
import { Tooltip, TooltipProvider } from "./Tooltip";

/** Nests its own `TooltipProvider` because Base UI keeps the open delay on the provider. */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={0}>
      <Tooltip
        side="top"
        content={
          <span className="block max-w-72 font-normal normal-case leading-snug">{children}</span>
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
