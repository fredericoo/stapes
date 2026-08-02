import { create } from "zustand";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import type { TimeOfDay } from "../lib/lighting";
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

/** Discrete map zoom steps (canvas px per world px). */
export const ZOOM_LEVELS = [1, 2, 4, 8] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export function snapZoom(z: number): ZoomLevel {
  let best: ZoomLevel = ZOOM_LEVELS[0];
  let bestDist = Math.abs(z - best);
  for (const level of ZOOM_LEVELS) {
    const dist = Math.abs(z - level);
    if (dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

export type LightingSettings = {
  timeOfDay: TimeOfDay;
};

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
  lighting: LightingSettings;
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
  setTimeOfDay: (t: TimeOfDay) => void;
  setTool: (tool: ToolId) => void;
  setSelected: (sel: { x: number; y: number } | null) => void;
  setHover: (h: { x: number; y: number } | null) => void;
  setArmedTileId: (id: string | null) => void;
  setZoom: (z: number) => void;
  setCamera: (c: { x: number; y: number }) => void;
  setShapePreview: (p: EditorStore["shapePreview"]) => void;
  markSaved: () => void;
  clearToast: () => void;

  /**
   * Apply a map mutation and record undo history.
   * All map data changes must go through this (or a store method that calls it).
   * Pass `{ coalesceInStroke: true }` only for per-cell steps inside beginStroke/endStroke.
   */
  commitMap: (next: MapFile, opts?: { coalesceInStroke?: boolean }) => void;
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
  lighting: { timeOfDay: "day" },
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
  setTimeOfDay: (t) => set({ lighting: { timeOfDay: t } }),
  setTool: (tool) => set({ tool }),
  setSelected: (sel) => set({ selected: sel }),
  setHover: (h) => {
    const prev = get().hover;
    if (prev === h) return;
    if (prev && h && prev.x === h.x && prev.y === h.y) return;
    if (!prev && !h) return;
    set({ hover: h });
  },
  setArmedTileId: (id) => set({ armedTileId: id }),
  setZoom: (z) => set({ zoom: snapZoom(z) }),
  setCamera: (c) => {
    const prev = get().camera;
    if (prev.x === c.x && prev.y === c.y) return;
    set({ camera: c });
  },
  setShapePreview: (p) => {
    const prev = get().shapePreview;
    if (prev === p) return;
    if (
      prev &&
      p &&
      prev.kind === p.kind &&
      prev.x0 === p.x0 &&
      prev.y0 === p.y0 &&
      prev.x1 === p.x1 &&
      prev.y1 === p.y1
    ) {
      return;
    }
    set({ shapePreview: p });
  },
  markSaved: () => set({ dirty: false, savedMap: get().map }),
  clearToast: () => set({ lastToast: null }),

  commitMap: (next, opts) => {
    if (next === get().map) return;

    // Per-cell drag steps coalesce into one undo entry via endStroke.
    if (opts?.coalesceInStroke && get().strokeBase) {
      const { mapVersion, savedMap } = get();
      set({
        map: next,
        dirty: next !== savedMap,
        mapVersion: mapVersion + 1,
        future: [],
      });
      return;
    }

    // Discrete edits (backspace, stack panel, stampMany, …) must always be
    // undoable on their own — close any open stroke first so they aren't
    // swallowed / undo isn't blocked by a stuck strokeBase.
    if (get().strokeBase) {
      get().endStroke();
    }

    const { map, currentLevel, mapVersion, past, savedMap } = get();
    if (next === map) return;
    set({
      map: next,
      dirty: next !== savedMap,
      mapVersion: mapVersion + 1,
      future: [],
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
    get().commitMap(clearStack(map, x, y, currentLevel), {
      coalesceInStroke: true,
    });
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
    get().commitMap(next, { coalesceInStroke: true });
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
    let last: { x: number; y: number } | null = null;
    for (const { x, y } of coords) {
      // Fresh clone per cell so stacks don't share identity across coords.
      const clone: PlacedTile[] = source.map((p) => ({ ...p }));
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
