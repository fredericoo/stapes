import { useEffect, useState, type ReactNode } from "react";
import { WindowFrameContext } from "./HudWindow";
import {
  loadCollapsedWindows,
  saveCollapsedWindows,
  toggleWindow,
  WINDOW_IDS,
  type WindowId,
} from "./windowLayout";

export function WindowStack({
  windows,
  className = "",
}: {
  windows: Partial<Record<WindowId, ReactNode>>;
  className?: string;
}) {
  /**
   * Seeded empty and read from storage after mount, because the server render
   * has no storage and a window minimised on the first client render would be
   * a hydration mismatch.
   */
  const [collapsed, setCollapsed] = useState<WindowId[]>([]);
  useEffect(() => setCollapsed(loadCollapsedWindows()), []);

  return (
    <div className={["flex min-h-0 flex-col gap-1", className].filter(Boolean).join(" ")}>
      {WINDOW_IDS.filter((id) => windows[id] != null).map((id) => {
        const folded = collapsed.includes(id);
        const frame = {
          collapsed: folded,
          onToggleCollapsed: () => {
            const next = toggleWindow(collapsed, id);
            setCollapsed(next);
            saveCollapsedWindows(next);
          },
        };
        return (
          <div
            key={id}
            className={folded || id !== "nearby" ? "shrink-0" : "flex min-h-24 flex-1 flex-col"}
          >
            <WindowFrameContext.Provider value={frame}>{windows[id]}</WindowFrameContext.Provider>
          </div>
        );
      })}
    </div>
  );
}
