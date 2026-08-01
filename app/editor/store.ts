import { create } from "zustand";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  appendTile,
  clearStack,
  getStack,
  removeTileAt,
  reorderStack,
  replaceStack,
  updatePlacedDirection,
} from "../lib/mapData";
import { canPlace, canReplaceStack, tilesByIdFromList } from "../lib/validation";

export type ToolId = "select" | "erase" | "pencil" | "rect" | "circle";

export type EditorStore = {
  map: MapFile;
  tiles: TileDef[];
  tilesById: Record<string, TileDef>;
  dirty: boolean;
  /** Bumps whenever map contents change — used by renderer to rebuild. */
  mapVersion: number;
  currentLevel: number;
  showOtherLevels: boolean;
  /** Every level at full opacity, no grid or selection chrome — how the game will look. */
  previewMode: boolean;
  tool: ToolId;
  selected: { x: number; y: number } | null;
  hover: { x: number; y: number } | null;
  armedTileId: string | null;
  zoom: number;
  /** Camera top-left in world pixels. */
  camera: { x: number; y: number };
  shapePreview: {
    kind: "rect" | "circle";
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null;
  lastToast: string | null;

  hydrate: (map: MapFile, tiles: TileDef[]) => void;
  setTiles: (tiles: TileDef[]) => void;
  setLevel: (z: number) => void;
  setShowOtherLevels: (v: boolean) => void;
  setPreviewMode: (v: boolean) => void;
  togglePreviewMode: () => void;
  setTool: (tool: ToolId) => void;
  setSelected: (sel: { x: number; y: number } | null) => void;
  setHover: (h: { x: number; y: number } | null) => void;
  setArmedTileId: (id: string | null) => void;
  setZoom: (z: number) => void;
  setCamera: (c: { x: number; y: number }) => void;
  setShapePreview: (p: EditorStore["shapePreview"]) => void;
  markSaved: () => void;
  clearToast: () => void;

  selectCoord: (x: number, y: number) => void;
  eraseAt: (x: number, y: number) => void;
  stampAt: (x: number, y: number) => { skipped: boolean; reason?: string };
  stampMany: (
    coords: Array<{ x: number; y: number }>,
  ) => { skipped: number; reason?: string };
  appendArmed: () => { ok: boolean; reason?: string };
  removeFromStack: (stackIndex: number) => void;
  reorderSelectedStack: (from: number, to: number) => void;
  setStackDirection: (stackIndex: number, direction: Direction) => void;
};

export const useEditorStore = create<EditorStore>((set, get) => ({
  map: { version: 1, levels: {} },
  tiles: [],
  tilesById: {},
  dirty: false,
  mapVersion: 0,
  currentLevel: 0,
  showOtherLevels: true,
  previewMode: false,
  tool: "select",
  selected: null,
  hover: null,
  armedTileId: null,
  zoom: 4,
  camera: { x: -32, y: -32 },
  shapePreview: null,
  lastToast: null,

  hydrate: (map, tiles) =>
    set({
      map,
      tiles,
      tilesById: tilesByIdFromList(tiles),
      dirty: false,
      mapVersion: get().mapVersion + 1,
    }),

  setTiles: (tiles) =>
    set({ tiles, tilesById: tilesByIdFromList(tiles) }),

  setLevel: (z) => set({ currentLevel: z }),
  setShowOtherLevels: (v) => set({ showOtherLevels: v }),
  setPreviewMode: (v) => set({ previewMode: v }),
  togglePreviewMode: () => set({ previewMode: !get().previewMode }),
  setTool: (tool) => set({ tool }),
  setSelected: (sel) => set({ selected: sel }),
  setHover: (h) => set({ hover: h }),
  setArmedTileId: (id) => set({ armedTileId: id }),
  setZoom: (z) => set({ zoom: z }),
  setCamera: (c) => set({ camera: c }),
  setShapePreview: (p) => set({ shapePreview: p }),
  markSaved: () => set({ dirty: false }),
  clearToast: () => set({ lastToast: null }),

  selectCoord: (x, y) => set({ selected: { x, y } }),

  eraseAt: (x, y) => {
    const { map, currentLevel, mapVersion } = get();
    const next = clearStack(map, x, y, currentLevel);
    set({ map: next, dirty: true, mapVersion: mapVersion + 1 });
  },

  stampAt: (x, y) => {
    const { map, selected, currentLevel, tilesById, mapVersion } = get();
    if (!selected) {
      return { skipped: true, reason: "No source selected" };
    }
    const source = getStack(map, selected.x, selected.y, currentLevel);
    const clone: PlacedTile[] = source.map((p) => ({ ...p }));
    const check = canReplaceStack(
      map,
      x,
      y,
      currentLevel,
      clone,
      tilesById,
    );
    if (!check.ok) {
      return { skipped: true, reason: check.reason };
    }
    const next = replaceStack(map, x, y, currentLevel, clone);
    set({ map: next, dirty: true, mapVersion: mapVersion + 1 });
    return { skipped: false };
  },

  stampMany: (coords) => {
    let skipped = 0;
    let reason: string | undefined;
    let { map, selected, currentLevel, tilesById, mapVersion } = get();
    if (!selected) {
      return { skipped: coords.length, reason: "No source selected" };
    }
    const source = getStack(map, selected.x, selected.y, currentLevel);
    const clone: PlacedTile[] = source.map((p) => ({ ...p }));
    let changed = false;
    for (const { x, y } of coords) {
      const check = canReplaceStack(map, x, y, currentLevel, clone, tilesById);
      if (!check.ok) {
        skipped++;
        reason = check.reason;
        continue;
      }
      map = replaceStack(map, x, y, currentLevel, clone);
      changed = true;
    }
    if (changed) {
      set({ map, dirty: true, mapVersion: mapVersion + 1 });
    }
    return { skipped, reason };
  },

  appendArmed: () => {
    const { map, selected, currentLevel, armedTileId, tilesById, mapVersion } =
      get();
    if (!selected) return { ok: false, reason: "No coordinate selected" };
    if (!armedTileId) return { ok: false, reason: "No tile armed" };
    const def = tilesById[armedTileId];
    if (!def) return { ok: false, reason: "Unknown tile" };
    const check = canPlace(
      map,
      selected.x,
      selected.y,
      currentLevel,
      def,
      tilesById,
    );
    if (!check.ok) return { ok: false, reason: check.reason };
    const placed: PlacedTile = def.directional
      ? { tileId: def.id, direction: "s" }
      : { tileId: def.id };
    const next = appendTile(
      map,
      selected.x,
      selected.y,
      currentLevel,
      placed,
    );
    set({ map: next, dirty: true, mapVersion: mapVersion + 1 });
    return { ok: true };
  },

  removeFromStack: (stackIndex) => {
    const { map, selected, currentLevel, mapVersion } = get();
    if (!selected) return;
    const next = removeTileAt(
      map,
      selected.x,
      selected.y,
      currentLevel,
      stackIndex,
    );
    set({ map: next, dirty: true, mapVersion: mapVersion + 1 });
  },

  reorderSelectedStack: (from, to) => {
    const { map, selected, currentLevel, mapVersion } = get();
    if (!selected) return;
    const next = reorderStack(
      map,
      selected.x,
      selected.y,
      currentLevel,
      from,
      to,
    );
    set({ map: next, dirty: true, mapVersion: mapVersion + 1 });
  },

  setStackDirection: (stackIndex, direction) => {
    const { map, selected, currentLevel, mapVersion } = get();
    if (!selected) return;
    const next = updatePlacedDirection(
      map,
      selected.x,
      selected.y,
      currentLevel,
      stackIndex,
      direction,
    );
    set({ map: next, dirty: true, mapVersion: mapVersion + 1 });
  },
}));
