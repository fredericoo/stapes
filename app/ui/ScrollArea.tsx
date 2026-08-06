import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode } from "react";

/**
 * Vertical scroll area with a hard-edged scrollbar matching the app chrome.
 */
export function ScrollArea({
  children,
  className = "",
  viewportClassName = "",
  contentClassName = "",
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
}) {
  return (
    <BaseScrollArea.Root
      className={["relative min-h-0 outline-none", className].join(" ")}
    >
      <BaseScrollArea.Viewport
        className={[
          "h-full overscroll-contain",
          "data-has-overflow-y:pr-3",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          viewportClassName,
        ].join(" ")}
      >
        <BaseScrollArea.Content className={contentClassName}>
          {children}
        </BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar
        orientation="vertical"
        className={[
          "flex touch-none select-none bg-panel p-0.5",
          "border-2 border-border shadow-hard-sm",
          "data-[orientation=vertical]:w-3 data-[orientation=vertical]:m-0.5",
          "data-[orientation=horizontal]:h-3 data-[orientation=horizontal]:m-0.5",
        ].join(" ")}
      >
        <BaseScrollArea.Thumb className="relative flex-1 bg-ink before:absolute before:-inset-0.5 before:content-['']" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
