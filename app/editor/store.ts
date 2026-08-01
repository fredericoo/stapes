import { create } from "zustand";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  appendTile,
  clearStack,
  getStack,
  removeTileAt,
  reorderStack,
  replaceStack,
  serializeMap,
  updatePlacedDirection,
} from "../lib/mapData";
import { canPlace, canReplaceStack, tilesByIdFromList } from "../lib/validation";

export type ToolId = "select" | "erase" | "pencil" | "rect" | "circle";

type HistoryEntry = {
  map: MapFile;
  level: number;
};

const HISTORY_LIMIT = 100;
const EMPTY_MAP: MapFile = { version: 1, levels: {} };

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

  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Snapshot taken at the start of a paint stroke; null when not painting. */
  strokeBase: HistoryEntry | null;
  /** Map reference as of the last hydrate/save — used for dirty checks. */
  savedMap: MapFile;

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

  commitMap: (next: MapFile) => void;
  beginStroke: () => void;
  endStroke: () => void;
  undo: () => void;
  redo: () => void;

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
  map: EMPTY_MAP,
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

  past: [],
  future: [],
  strokeBase: null,
  savedMap: EMPTY_MAP,

  hydrate: (map, tiles) => {
    const state = get();
    const tilesById = tilesByIdFromList(tiles);
    // Revalidation after save produces a new map identity with the same
    // contents — keep history and the current map reference so dirty checks
    // against savedMap stay meaningful.
    if (serializeMap(map) === serializeMap(state.map)) {
      set({
        tiles,
        tilesById,
        savedMap: state.map,
        dirty: false,
        strokeBase: null,
      });
      return;
    }
    set({
      map,
      tiles,
      tilesById,
      dirty: false,
      mapVersion: state.mapVersion + 1,
      savedMap: map,
      past: [],
      future: [],
      strokeBase: null,
    });
  },

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
  markSaved: () => set({ dirty: false, savedMap: get().map }),
  clearToast: () => set({ lastToast: null }),

  commitMap: (next) => {
    const { map, currentLevel, mapVersion, past, strokeBase, savedMap } = get();
    if (next === map) return;
    const base = {
      map: next,
      dirty: next !== savedMap,
      mapVersion: mapVersion + 1,
      future: [] as HistoryEntry[],
    };
    // During a drag the base snapshot was captured by beginStroke, so skip
    // per-cell pushes — endStroke will push a single entry.
    if (strokeBase) {
      set(base);
      return;
    }
    set({
      ...base,
      past: [...past, { map, level: currentLevel }].slice(-HISTORY_LIMIT),
    });
  },

  beginStroke: () => {
    const { map, currentLevel, strokeBase } = get();
    if (strokeBase) return;
    set({ strokeBase: { map, level: currentLevel } });
  },

  endStroke: () => {
    const { map, strokeBase, past } = get();
    if (!strokeBase) return;
    if (map === strokeBase.map) {
      set({ strokeBase: null });
      return;
    }
    set({
      strokeBase: null,
      past: [...past, strokeBase].slice(-HISTORY_LIMIT),
    });
  },

  undo: () => {
    const { past, future, map, currentLevel, mapVersion, savedMap, strokeBase } =
      get();
    if (strokeBase || past.length === 0) return;
    const entry = past[past.length - 1]!;
    set({
      past: past.slice(0, -1),
      future: [...future, { map, level: currentLevel }],
      map: entry.map,
      currentLevel: entry.level,
      mapVersion: mapVersion + 1,
      dirty: entry.map !== savedMap,
    });
  },

  redo: () => {
    const { past, future, map, currentLevel, mapVersion, savedMap, strokeBase } =
      get();
    if (strokeBase || future.length === 0) return;
    const entry = future[future.length - 1]!;
    set({
      future: future.slice(0, -1),
      past: [...past, { map, level: currentLevel }],
      map: entry.map,
      currentLevel: entry.level,
      mapVersion: mapVersion + 1,
      dirty: entry.map !== savedMap,
    });
  },

  selectCoord: (x, y) => set({ selected: { x, y } }),

  eraseAt: (x, y) => {
    const { map, currentLevel } = get();
    get().commitMap(clearStack(map, x, y, currentLevel));
  },

  stampAt: (x, y) => {
    const { map, selected, currentLevel, tilesById } = get();
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
    // Selection trails the brush: the cell we just wrote holds an identical
    // stack, so the source is unchanged and the panel shows what you painted.
    get().commitMap(next);
    set({ selected: { x, y } });
    return { skipped: false };
  },

  stampMany: (coords) => {
    let skipped = 0;
    let reason: string | undefined;
    let { map, selected, currentLevel, tilesById } = get();
    if (!selected) {
      return { skipped: coords.length, reason: "No source selected" };
    }
    const source = getStack(map, selected.x, selected.y, currentLevel);
    const clone: PlacedTile[] = source.map((p) => ({ ...p }));
    let last: { x: number; y: number } | null = null;
    for (const { x, y } of coords) {
      const check = canReplaceStack(map, x, y, currentLevel, clone, tilesById);
      if (!check.ok) {
        skipped++;
        reason = check.reason;
        continue;
      }
      map = replaceStack(map, x, y, currentLevel, clone);
      last = { x, y };
    }
    if (last) {
      get().commitMap(map);
      set({ selected: last });
    }
    return { skipped, reason };
  },

  appendArmed: () => {
    const { map, selected, currentLevel, armedTileId, tilesById } = get();
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
    get().commitMap(
      appendTile(map, selected.x, selected.y, currentLevel, placed),
    );
    return { ok: true };
  },

  removeFromStack: (stackIndex) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      removeTileAt(map, selected.x, selected.y, currentLevel, stackIndex),
    );
  },

  reorderSelectedStack: (from, to) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      reorderStack(map, selected.x, selected.y, currentLevel, from, to),
    );
  },

  setStackDirection: (stackIndex, direction) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedDirection(
        map,
        selected.x,
        selected.y,
        currentLevel,
        stackIndex,
        direction,
      ),
    );
  },
}));
