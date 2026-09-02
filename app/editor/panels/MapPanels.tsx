import { useCallback, useEffect, useRef } from "react";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import {
  LayoutProvider,
  LayoutRoot,
  Resizer,
  TabList,
  TabPanel as SplitTabPanel,
  tabPanelElementId,
  useLayout,
  useLayoutContext,
  usePanel,
  type LayoutNode,
  type PanelNode,
  type RenderPanelProps,
  type RenderResizerProps,
  type TabRegistry,
} from "react-splitkit";
import type { TileDef, TilesetDef } from "../../lib/types";
import { Tooltip } from "../../ui";
import { CanvasPanel } from "./CanvasPanel";
import { MapAssetsProvider } from "./MapAssetsContext";
import { SelectionPanel, SelectionTabLabel } from "./SelectionPanel";
import { TilePickerPanel } from "./TilePickerPanel";
import {
  TAB_MAP_VIEW,
  TAB_SELECTION,
  TAB_TILE_PICKER,
  createDefaultLayout,
  loadLayout,
  saveLayout,
} from "./layout";

/**
 * `minSize` / `maxSize` are percentages of the parent split. The map's bounds
 * are what stop the sidebar collapsing to nothing or swallowing the canvas —
 * the sidebar itself is a split, and splitkit only reads constraints off panels.
 */
const registry: TabRegistry = {
  [TAB_TILE_PICKER]: {
    tabType: TAB_TILE_PICKER,
    title: "Tile picker",
    closable: false,
    minSize: 15,
    render: () => <TilePickerPanel />,
  },
  [TAB_SELECTION]: {
    tabType: TAB_SELECTION,
    title: "Selection",
    closable: false,
    minSize: 15,
    renderLabel: () => <SelectionTabLabel />,
    render: () => <SelectionPanel />,
  },
  [TAB_MAP_VIEW]: {
    tabType: TAB_MAP_VIEW,
    title: "Map",
    closable: false,
    minSize: 45,
    maxSize: 85,
    render: () => <CanvasPanel />,
  },
};

const COLLAPSIBLE_TAB_TYPES = new Set([TAB_TILE_PICKER, TAB_SELECTION]);

const DEFAULT_LAYOUT = createDefaultLayout();

/** Panels manage their own scrolling, so override the library's `overflow: auto`. */
const PANEL_CONTENT_STYLE = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;

/**
 * A collapsed panel is only tall enough for its title bar. Hiding rather than
 * unmounting keeps panel state (search text, scroll position) while also
 * taking the offscreen controls out of the tab order.
 */
const COLLAPSED_CONTENT_STYLE = {
  ...PANEL_CONTENT_STYLE,
  display: "none",
} as const;

const SAVE_DEBOUNCE_MS = 250;

function PanelTitleBar({ panel }: { panel: PanelNode }) {
  const { toggleCollapse } = usePanel(panel.id);
  const { idPrefix } = useLayoutContext();

  const activeTab =
    panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
  const collapsed = panel.collapsed ?? false;
  const collapsible = panel.tabs.some((tab) =>
    COLLAPSIBLE_TAB_TYPES.has(tab.tabType),
  );

  return (
    <div
      className={[
        "flex items-center border-b-2 border-border bg-ink",
        // Fill the collapsed strip so it reads as a single title bar.
        collapsed ? "flex-1" : "shrink-0",
      ].join(" ")}
    >
      <TabList
        panelId={panel.id}
        className="flex min-w-0 flex-1"
        renderTab={({ isActive, tabProps, label }) => (
          <button
            type="button"
            {...tabProps}
            className={[
              "flex min-w-0 items-center px-2 py-1 text-xs font-bold tracking-wide uppercase",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
              isActive ? "text-paper" : "text-paper/60 hover:text-paper",
            ].join(" ")}
          >
            <span className="truncate">{label}</span>
          </button>
        )}
      />
      {collapsible && activeTab ? (
        <Tooltip content={collapsed ? "Expand panel" : "Collapse panel"}>
          <button
            type="button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${activeTab.title}`}
            aria-expanded={!collapsed}
            aria-controls={tabPanelElementId(panel.id, activeTab.id, idPrefix)}
            onClick={() => toggleCollapse()}
            className="mr-1 shrink-0 p-1 text-paper/70 hover:bg-paper/20 hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            {collapsed ? (
              <IconChevronDown size={14} aria-hidden="true" />
            ) : (
              <IconChevronUp size={14} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * Called as a plain function by `LayoutRoot`, not rendered as a component —
 * anything needing hooks has to live in a child component like PanelTitleBar.
 */
function renderPanelChrome({ panel, style }: RenderPanelProps) {
  return (
    <div style={style} className="overflow-hidden bg-panel">
      <PanelTitleBar panel={panel} />
      <SplitTabPanel
        panelId={panel.id}
        style={panel.collapsed ? COLLAPSED_CONTENT_STYLE : PANEL_CONTENT_STYLE}
      />
    </div>
  );
}

/** The 4px handle doubles as the border between panels. */
function renderResizer({ splitId, index }: RenderResizerProps) {
  return (
    <Resizer
      splitId={splitId}
      index={index}
      className="bg-border hover:bg-accent data-resizing:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    />
  );
}

/**
 * LayoutProvider snapshots `initialLayout` on mount and the server has no
 * localStorage, so a saved tree is applied just after hydration instead.
 */
function RestoreSavedLayout() {
  const { dispatch } = useLayout();

  useEffect(() => {
    const saved = loadLayout();
    if (saved) dispatch({ type: "REPLACE_LAYOUT", layout: saved });
  }, [dispatch]);

  return null;
}

export function MapPanels({
  tiles,
  tilesets,
}: {
  tiles: TileDef[];
  tilesets: TilesetDef[];
}) {
  const pending = useRef<LayoutNode | null>(null);
  const saveTimer = useRef<number | null>(null);

  const writePending = useCallback(() => {
    const layout = pending.current;
    pending.current = null;
    if (layout) saveLayout(layout);
  }, []);

  // Dragging a resizer dispatches on every pointer move; batch the writes.
  const handleLayoutChange = useCallback(
    (layout: LayoutNode) => {
      pending.current = layout;
      if (saveTimer.current !== null) return;
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        writePending();
      }, SAVE_DEBOUNCE_MS);
    },
    [writePending],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      writePending();
    },
    [writePending],
  );

  return (
    <MapAssetsProvider tiles={tiles} tilesets={tilesets}>
      <LayoutProvider
        initialLayout={DEFAULT_LAYOUT}
        registry={registry}
        onChange={handleLayoutChange}
      >
        <RestoreSavedLayout />
        {/* Maximizing overlays a second copy of the panel, which would mean a
            second WebGL canvas, so keep it out of this layout. */}
        <LayoutRoot
          renderPanel={renderPanelChrome}
          renderResizer={renderResizer}
          maximizeMode="inline"
        />
      </LayoutProvider>
    </MapAssetsProvider>
  );
}
