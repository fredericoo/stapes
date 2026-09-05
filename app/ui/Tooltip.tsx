import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/**
 * Shares an open delay across every tooltip so moving along a toolbar
 * shows adjacent tooltips instantly.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={400} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  );
}

export function Tooltip({
  content,
  side = "bottom",
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** The trigger. Must accept a ref and spread props onto a DOM element. */
  children: ReactElement;
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        {/* The z-index goes on the positioner, which is the element that is
            actually positioned: on the popup inside it, it only orders the
            popup within the positioner's own stacking context, and the whole
            thing sorts under a dialog's `z-50`. */}
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-[90]">
          <BaseTooltip.Popup className="border-2 border-border bg-paper px-2 py-1 text-xs text-ink shadow-hard">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
