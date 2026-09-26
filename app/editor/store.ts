import { MAP_FILE_VERSION } from "../lib/types";
import { create } from "zustand";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import type { ItemInstance } from "../lib/itemInstance";
import { isDirectional } from "../lib/types";
import { DEFAULT_EDITOR_MINUTES, type MinutesOfDay, wrapMinutes } from "../lib/clock";
import {
  appendTile,
  clearStack,
  getStack,
  removeTileAt,
  reorderStack,
  replaceStack,
  serializeMap,
  setStacks,
  updatePlacedChannel,
  updatePlacedContents,
  updatePlacedDescription,
  updatePlacedInscription,
  updatePlacedEngraving,
  updatePlacedReward,
  updatePlacedTeleport,
  updatePlacedDirection,
  updatePlacedFoot,
  updatePlacedVariant,
} from "../lib/mapData";
import { canPlace, canReplaceStack, fitsFoot, tilesByIdFromList } from "../lib/validation";
import type { Rect } from "./generator";
import { activeConfig, planProcedural, type ProceduralSettings } from "./procedural";
import {
  DEFAULT_PROCEDURAL_SETTINGS,
  loadProceduralSettings,
  saveProceduralSettings,
} from "./proceduralSettings";

export type ToolId = "select" | "erase" | "pencil" | "rect" | "circle" | "bucket" | "procedural";

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
  minutesOfDay: MinutesOfDay;
  enabled: boolean;
};

type HistoryEntry = {
  map: MapFile;
  level: number;
};

const HISTORY_LIMIT = 100;
const EMPTY_MAP: MapFile = { version: MAP_FILE_VERSION, levels: {} };

export type EditorStore = {
  map: MapFile;
  tiles: TileDef[];
  tilesById: Record<string, TileDef>;
  dirty: boolean;
  mapVersion: number;
  currentLevel: number;
  showOtherLevels: boolean;
  previewMode: boolean;
  lighting: LightingSettings;
  tool: ToolId;
  selected: { x: number; y: number } | null;
  hover: { x: number; y: number } | null;
  armedTileId: string | null;
  armedVariant: string | null;
  proceduralSettings: ProceduralSettings;
  proceduralSettingsVersion: number;
  zoom: ZoomLevel;
  camera: { x: number; y: number };
  shapePreview: {
    kind: "rect" | "circle" | "procedural";
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null;
  lastToast: string | null;

  past: HistoryEntry[];
  future: HistoryEntry[];
  strokeBase: HistoryEntry | null;
  savedMap: MapFile;

  hydrate: (map: MapFile, tiles: TileDef[]) => void;
  setTiles: (tiles: TileDef[]) => void;
  setLevel: (z: number) => void;
  setShowOtherLevels: (v: boolean) => void;
  toggleShowOtherLevels: () => void;
  setPreviewMode: (v: boolean) => void;
  togglePreviewMode: () => void;
  setMinutesOfDay: (m: MinutesOfDay) => void;
  setLightingEnabled: (v: boolean) => void;
  toggleLightingEnabled: () => void;
  setTool: (tool: ToolId) => void;
  setSelected: (sel: { x: number; y: number } | null) => void;
  setHover: (h: { x: number; y: number } | null) => void;
  setArmedTileId: (id: string | null) => void;
  setArmedVariant: (variant: string | null) => void;
  setProceduralSettings: (settings: ProceduralSettings) => void;
  setZoom: (z: number) => void;
  setCamera: (c: { x: number; y: number }) => void;
  setShapePreview: (p: EditorStore["shapePreview"]) => void;
  markSaved: () => void;
  clearToast: () => void;

  /**
   * All map data changes must go through this (or a store method that calls
   * it), so undo history stays complete. Pass `{ coalesceInStroke: true }`
   * only for per-cell steps inside beginStroke/endStroke.
   */
  commitMap: (next: MapFile, opts?: { coalesceInStroke?: boolean }) => void;
  beginStroke: () => void;
  endStroke: () => void;
  undo: () => void;
  redo: () => void;

  selectCoord: (x: number, y: number) => void;
  eraseAt: (x: number, y: number) => void;
  stampAt: (x: number, y: number) => { skipped: boolean; reason?: string };
  stampMany: (coords: Array<{ x: number; y: number }>) => { skipped: number; reason?: string };
  appendArmed: () => { ok: boolean; reason?: string };
  placeProcedural: (rect: Rect) => { ok: boolean; reason?: string };
  removeFromStack: (stackIndex: number) => void;
  reorderSelectedStack: (from: number, to: number) => void;
  setStackDirection: (stackIndex: number, direction: Direction) => void;
  setStackVariant: (stackIndex: number, variant: string) => void;
  setStackFoot: (stackIndex: number, foot: number | null) => { ok: boolean; reason?: string };
  setStackChannel: (stackIndex: number, channel: string) => void;
  setStackInscription: (stackIndex: number, inscription: string) => void;
  setStackDescription: (stackIndex: number, description: string) => void;
  setStackEngraving: (stackIndex: number, engraved: string) => void;
  setStackReward: (stackIndex: number, tag: string, tileIds: readonly string[]) => void;
  setStackTeleport: (stackIndex: number, to: Coord | null) => void;
  setStackContents: (stackIndex: number, contents: readonly ItemInstance[]) => void;
};

function armedPlacement(def: TileDef, variant: string | null): PlacedTile {
  const placed: PlacedTile = { tileId: def.id };
  if (isDirectional(def)) placed.direction = "s";
  if (def.type === "variant" && variant) placed.variant = variant;
  return placed;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  map: EMPTY_MAP,
  tiles: [],
  tilesById: {},
  dirty: false,
  mapVersion: 0,
  currentLevel: 0,
  showOtherLevels: true,
  previewMode: false,
  lighting: { minutesOfDay: DEFAULT_EDITOR_MINUTES, enabled: true },
  tool: "select",
  selected: null,
  hover: null,
  armedTileId: null,
  armedVariant: null,
  proceduralSettings: DEFAULT_PROCEDURAL_SETTINGS,
  proceduralSettingsVersion: 0,
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
    const proceduralSettings = loadProceduralSettings((id: string) => id in tilesById);
    if (serializeMap(map) === serializeMap(state.map)) {
      set({
        tiles,
        tilesById,
        proceduralSettings,
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
      proceduralSettings,
      dirty: false,
      mapVersion: state.mapVersion + 1,
      savedMap: map,
      past: [],
      future: [],
      strokeBase: null,
    });
  },

  setTiles: (tiles) => set({ tiles, tilesById: tilesByIdFromList(tiles) }),

  setLevel: (z) => set({ currentLevel: z }),
  setShowOtherLevels: (v) => set({ showOtherLevels: v }),
  toggleShowOtherLevels: () => set({ showOtherLevels: !get().showOtherLevels }),
  setPreviewMode: (v) => set({ previewMode: v }),
  togglePreviewMode: () => set({ previewMode: !get().previewMode }),
  setMinutesOfDay: (m) =>
    set({
      lighting: { ...get().lighting, minutesOfDay: wrapMinutes(Math.floor(m)) },
    }),
  setLightingEnabled: (v) => set({ lighting: { ...get().lighting, enabled: v } }),
  toggleLightingEnabled: () =>
    set({ lighting: { ...get().lighting, enabled: !get().lighting.enabled } }),
  setTool: (tool) => set({ tool }),
  setSelected: (sel) => set({ selected: sel }),
  setHover: (h) => {
    const prev = get().hover;
    if (prev === h) return;
    if (prev && h && prev.x === h.x && prev.y === h.y) return;
    if (!prev && !h) return;
    set({ hover: h });
  },
  /**
   * Arming a different tile drops the face with it: a face name belongs to
   * one tile's catalogue, and carrying it over to another variant tile would
   * silently place that tile's first face while the picker said otherwise.
   */
  setArmedTileId: (id) =>
    set(id === get().armedTileId ? { armedTileId: id } : { armedTileId: id, armedVariant: null }),
  setArmedVariant: (variant) => set({ armedVariant: variant }),
  setProceduralSettings: (settings) => {
    saveProceduralSettings(settings);
    set({
      proceduralSettings: settings,
      proceduralSettingsVersion: get().proceduralSettingsVersion + 1,
    });
  },
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
    const { past, future, map, currentLevel, mapVersion, savedMap, strokeBase } = get();
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
    const { past, future, map, currentLevel, mapVersion, savedMap, strokeBase } = get();
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
    const { map, selected, currentLevel, tilesById, armedTileId, armedVariant } = get();

    if (selected) {
      const source = getStack(map, selected.x, selected.y, currentLevel);
      const clone: PlacedTile[] = source.map((p) => ({ ...p }));
      const check = canReplaceStack(map, x, y, currentLevel, clone, tilesById);
      if (!check.ok) {
        return { skipped: true, reason: check.reason };
      }
      get().commitMap(replaceStack(map, x, y, currentLevel, clone), {
        coalesceInStroke: true,
      });
      return { skipped: false };
    }

    if (!armedTileId) {
      return { skipped: true, reason: "No tile armed" };
    }
    const def = tilesById[armedTileId];
    if (!def) return { skipped: true, reason: "Unknown tile" };
    const check = canPlace(map, x, y, currentLevel, def, tilesById);
    if (!check.ok) return { skipped: true, reason: check.reason };
    const placed = armedPlacement(def, armedVariant);
    get().commitMap(appendTile(map, x, y, currentLevel, placed), {
      coalesceInStroke: true,
    });
    return { skipped: false };
  },

  stampMany: (coords) => {
    let skipped = 0;
    let reason: string | undefined;
    let { map, selected, currentLevel, tilesById, armedTileId, armedVariant } = get();
    let wrote = false;

    if (selected) {
      const source = getStack(map, selected.x, selected.y, currentLevel);
      for (const { x, y } of coords) {
        const clone: PlacedTile[] = source.map((p) => ({ ...p }));
        const check = canReplaceStack(map, x, y, currentLevel, clone, tilesById);
        if (!check.ok) {
          skipped++;
          reason = check.reason;
          continue;
        }
        map = replaceStack(map, x, y, currentLevel, clone);
        wrote = true;
      }
    } else {
      if (!armedTileId) {
        return { skipped: coords.length, reason: "No tile armed" };
      }
      const def = tilesById[armedTileId];
      if (!def) return { skipped: coords.length, reason: "Unknown tile" };
      const placed = armedPlacement(def, armedVariant);
      for (const { x, y } of coords) {
        const check = canPlace(map, x, y, currentLevel, def, tilesById);
        if (!check.ok) {
          skipped++;
          reason = check.reason;
          continue;
        }
        map = appendTile(map, x, y, currentLevel, { ...placed });
        wrote = true;
      }
    }

    if (wrote) get().commitMap(map);
    return { skipped, reason };
  },

  appendArmed: () => {
    const { map, selected, currentLevel, armedTileId, tilesById, armedVariant } = get();
    if (!selected) return { ok: false, reason: "No coordinate selected" };
    if (!armedTileId) return { ok: false, reason: "No tile armed" };
    const def = tilesById[armedTileId];
    if (!def) return { ok: false, reason: "Unknown tile" };
    const check = canPlace(map, selected.x, selected.y, currentLevel, def, tilesById);
    if (!check.ok) return { ok: false, reason: check.reason };
    const placed = armedPlacement(def, armedVariant);
    get().commitMap(appendTile(map, selected.x, selected.y, currentLevel, placed));
    return { ok: true };
  },

  placeProcedural: (rect) => {
    const { map, currentLevel, tilesById, proceduralSettings } = get();
    const plan = planProcedural(
      map,
      tilesById,
      rect,
      currentLevel,
      activeConfig(proceduralSettings),
    );
    if (!plan.ok) return { ok: false, reason: plan.reason };
    get().commitMap(setStacks(map, plan.edits));
    return { ok: true };
  },

  removeFromStack: (stackIndex) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(removeTileAt(map, selected.x, selected.y, currentLevel, stackIndex));
  },

  reorderSelectedStack: (from, to) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(reorderStack(map, selected.x, selected.y, currentLevel, from, to));
  },

  setStackDirection: (stackIndex, direction) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedDirection(map, selected.x, selected.y, currentLevel, stackIndex, direction),
    );
  },

  setStackVariant: (stackIndex, variant) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedVariant(map, selected.x, selected.y, currentLevel, stackIndex, variant),
    );
  },

  setStackFoot: (stackIndex, foot) => {
    const { map, selected, currentLevel, tilesById } = get();
    if (!selected) return { ok: false, reason: "No coordinate selected" };

    const stack = getStack(map, selected.x, selected.y, currentLevel);
    if (foot != null) {
      const check = fitsFoot(stack, stackIndex, foot, tilesById);
      if (!check.ok) return { ok: false, reason: check.reason };
    }

    get().commitMap(
      updatePlacedFoot(map, selected.x, selected.y, currentLevel, stackIndex, foot, tilesById),
    );
    return { ok: true };
  },

  setStackChannel: (stackIndex, channel) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedChannel(map, selected.x, selected.y, currentLevel, stackIndex, channel),
    );
  },

  setStackInscription: (stackIndex, inscription) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedInscription(map, selected.x, selected.y, currentLevel, stackIndex, inscription),
    );
  },

  setStackDescription: (stackIndex, description) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedDescription(map, selected.x, selected.y, currentLevel, stackIndex, description),
    );
  },

  setStackEngraving: (stackIndex, engraved) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedEngraving(map, selected.x, selected.y, currentLevel, stackIndex, engraved),
    );
  },

  setStackReward: (stackIndex, tag, tileIds) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedReward(map, selected.x, selected.y, currentLevel, stackIndex, tag, tileIds),
    );
  },

  setStackTeleport: (stackIndex, to) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedTeleport(map, selected.x, selected.y, currentLevel, stackIndex, to),
    );
  },

  setStackContents: (stackIndex, contents) => {
    const { map, selected, currentLevel } = get();
    if (!selected) return;
    get().commitMap(
      updatePlacedContents(map, selected.x, selected.y, currentLevel, stackIndex, contents),
    );
  },
}));
