import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

const HOVER_DELAY_MS = 400;

export function TooltipProvider({
  children,
  delay = HOVER_DELAY_MS,
}: {
  children: ReactNode;
  delay?: number;
}) {
  return (
    <BaseTooltip.Provider delay={delay} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  );
}

const COLLISION_PADDING_PX = 8;

export function Tooltip({
  content,
  side = "bottom",
  align = "center",
  open,
  className = "",
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  className?: string;
  children: ReactElement;
}) {
  return (
    <BaseTooltip.Root open={open}>
      <BaseTooltip.Trigger render={children} />
      {/**
       * Portalled because a tooltip inside a vertically scrolling column, such as
       * `ItemSlot`'s, is clipped otherwise: `overflow-y: auto` makes `overflow-x`
       * compute to `auto` too.
       */}
      <BaseTooltip.Portal>
        {/**
         * The z-index goes on the positioner, which is the element that is
         * actually positioned. On the popup inside it, it would only order the
         * popup within the positioner's own stacking context, and the whole
         * thing would still sort under a dialog's `z-50`.
         */}
        <BaseTooltip.Positioner
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={COLLISION_PADDING_PX}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          className="z-[90]"
        >
          <BaseTooltip.Popup
            className={[
              "border-2 border-border bg-paper px-2 py-1 text-xs text-ink shadow-hard",
              "max-w-[min(20rem,calc(100vw-1rem))]",
              className,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
