import {
  createPanel,
  createSplit,
  isPanel,
  type LayoutNode,
  type TabDescriptor,
} from "react-splitkit";

/** Tab kinds registered with react-splitkit. */
export const TAB_TILE_PICKER = "tile-picker";
export const TAB_SELECTION = "selection";
export const TAB_MAP_VIEW = "map-view";

/** Bump when the panel set changes so stale saved layouts are discarded. */
const STORAGE_KEY = "stapes:map-layout:v1";

const REQUIRED_TAB_TYPES = [TAB_TILE_PICKER, TAB_SELECTION, TAB_MAP_VIEW];

export function createDefaultLayout(): LayoutNode {
  return createSplit(
    "root",
    "horizontal",
    [
      createSplit(
        "sidebar",
        "vertical",
        [
          createPanel("panel-tile-picker", [
            {
              id: "tab-tile-picker",
              tabType: TAB_TILE_PICKER,
              title: "Tile picker",
              closable: false,
            },
          ]),
          createPanel("panel-selection", [
            {
              id: "tab-selection",
              tabType: TAB_SELECTION,
              title: "Selection",
              closable: false,
            },
          ]),
        ],
        [45, 55],
      ),
      createPanel("panel-map-view", [
        {
          id: "tab-map-view",
          tabType: TAB_MAP_VIEW,
          title: "Map",
          closable: false,
        },
      ]),
    ],
    [22, 78],
  );
}

function isTabDescriptor(value: unknown): value is TabDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    typeof tab.tabType === "string" &&
    typeof tab.title === "string"
  );
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== "string") return false;

  if (node.type === "panel") {
    return Array.isArray(node.tabs) && node.tabs.every(isTabDescriptor);
  }

  if (node.type === "split") {
    return (
      (node.direction === "horizontal" || node.direction === "vertical") &&
      Array.isArray(node.children) &&
      Array.isArray(node.sizes) &&
      node.sizes.length === node.children.length &&
      node.sizes.every(
        (size: unknown) => typeof size === "number" && Number.isFinite(size),
      ) &&
      node.children.every(isLayoutNode)
    );
  }

  return false;
}

function collectTabTypes(node: LayoutNode, into: Set<string>): void {
  if (isPanel(node)) {
    for (const tab of node.tabs) into.add(tab.tabType);
    return;
  }
  for (const child of node.children) collectTabTypes(child, into);
}

/**
 * A saved tree is only usable if it still holds exactly the tabs this page
 * knows how to render — otherwise restoring it could strand the canvas.
 */
function hasExpectedTabs(layout: LayoutNode): boolean {
  const types = new Set<string>();
  collectTabTypes(layout, types);
  return (
    types.size === REQUIRED_TAB_TYPES.length &&
    REQUIRED_TAB_TYPES.every((tabType) => types.has(tabType))
  );
}

export function loadLayout(): LayoutNode | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isLayoutNode(parsed) || !hasExpectedTabs(parsed)) return null;
    return parsed;
  } catch {
    // Unparseable, or storage is blocked — fall back to the default layout.
    return null;
  }
}

export function saveLayout(layout: LayoutNode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage blocked or full: panel sizes just won't survive a reload.
  }
}
