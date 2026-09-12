import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/** The wait a tooltip nobody asked for should sit behind. */
const HOVER_DELAY_MS = 400;

/**
 * Shares an open delay across every tooltip so moving along a toolbar
 * shows adjacent tooltips instantly.
 *
 * The delay is what stops a sweep across a toolbar flashing six tooltips on the
 * way past — it is there for the pointer that is only travelling. A control
 * whose whole purpose is to be hovered has already been aimed at by the time it
 * is under the pointer, so it nests its own provider with no delay at all; see
 * `./InfoTip`. Base UI keeps the delay on the provider rather than on a root,
 * so nesting one is how a subtree says it wants a different wait.
 */
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

/**
 * How far a popup stays from the edge of whatever is clipping it.
 *
 * Larger than Base UI's default of five. A card sitting flush against the edge
 * of a phone screen looks cut off even when none of it is.
 */
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
  /**
   * Force it open or shut, instead of letting a hover decide.
   *
   * For a surface whose own rules say when a description is wanted — an item
   * slot answers a resting mouse or a held finger, with none of the half-second
   * delay a hover tooltip is built around. Absent is the ordinary case and
   * leaves Base UI in charge.
   */
  open?: boolean;
  /** Extra classes on the popup, for a tooltip that is a card rather than a line. */
  className?: string;
  /** The trigger. Must accept a ref and spread props onto a DOM element. */
  children: ReactElement;
}) {
  return (
    <BaseTooltip.Root open={open}>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        {/* The z-index goes on the positioner, which is the element that is
            actually positioned: on the popup inside it, it only orders the
            popup within the positioner's own stacking context, and the whole
            thing sorts under a dialog's `z-50`. */}
        <BaseTooltip.Positioner
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={COLLISION_PADDING_PX}
          // Flip to the other side when the requested one will not fit, and
          // slide along the other axis rather than flipping there too. A card
          // anchored on a 44px square near the edge of a phone has nowhere to
          // flip to that fits either — both ends overflow — so shifting is the
          // only correction that can put the whole of it on screen.
          collisionAvoidance={{ side: "flip", align: "shift" }}
          className="z-[90]"
        >
          <BaseTooltip.Popup
            className={[
              "border-2 border-border bg-paper px-2 py-1 text-xs text-ink shadow-hard",
              // Never wider than the screen it is being read on. Without this a
              // long line sets the popup's width and the shift above has
              // nothing left to work with — a card wider than the boundary
              // overflows whichever way it is nudged.
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
