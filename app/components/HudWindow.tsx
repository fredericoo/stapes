import { createContext, useContext, type ReactNode } from "react";
import { IconClose } from "./pixelIcons";

const CONTROL_ICON_SIZE_PX = 10;

export type WindowFrame = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

/**
 * Supplied by `WindowStack` to each window it holds. A window rendered
 * outside a stack, as every panel is on a phone, gets no minimise button.
 */
export const WindowFrameContext = createContext<WindowFrame | null>(null);

/**
 * `flush` drops the well's padding, for a body that scrolls: a scroller clips
 * at its own box, so padding around it left a band of well between the cut
 * and the frame. The scroller carries the padding inside itself instead.
 */
export function HudWindow({
  title,
  icon,
  meta,
  onClose,
  closeLabel,
  grows = false,
  flush = false,
  label,
  className = "",
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  grows?: boolean;
  flush?: boolean;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const frame = useContext(WindowFrameContext);
  const collapsed = frame?.collapsed ?? false;

  return (
    <section
      aria-label={label}
      className={[
        "hud-window bevel-raised flex flex-col",
        grows && !collapsed ? "min-h-24 flex-1" : "shrink-0",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="hud-window__title flex h-6 shrink-0 items-center gap-1 pr-0.5 pl-1">
        {icon}
        <h2 className="min-w-0 flex-1 truncate text-detail uppercase tracking-wide text-paper/80">
          {title}
        </h2>
        {meta ? (
          <span className="flex shrink-0 items-center gap-1 text-detail tabular-nums text-paper/60">
            {meta}
          </span>
        ) : null}
        {frame ? (
          <WindowControl
            label={collapsed ? `Expand ${label}` : `Minimise ${label}`}
            onPress={frame.onToggleCollapsed}
          >
            <span
              aria-hidden="true"
              className={
                collapsed ? "block h-2 w-2 border border-current" : "block h-px w-2 bg-current"
              }
            />
          </WindowControl>
        ) : null}
        {onClose ? (
          <WindowControl label={closeLabel ?? `Close ${label}`} onPress={onClose}>
            <IconClose size={CONTROL_ICON_SIZE_PX} aria-hidden="true" />
          </WindowControl>
        ) : null}
      </div>
      {collapsed ? null : (
        <div
          className={[
            "hud-well bevel-sunken m-0.5 flex min-h-0 flex-col gap-1",
            flush ? "" : "p-1",
            grows ? "flex-1" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {children}
        </div>
      )}
    </section>
  );
}

function WindowControl({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={label}
      className="hud-button grid h-4 w-4 shrink-0 place-items-center text-paper/80 hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-7 pointer-coarse:w-7"
    >
      {children}
    </button>
  );
}
