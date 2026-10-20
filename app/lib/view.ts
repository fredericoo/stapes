import { MAX_LEVEL, MIN_LEVEL } from "./types";

export const VIEW_CELLS = 23;

export const MESH_WINDOW_MARGIN = 6;

/**
 * How many levels above and below the viewer are drawn, lit and sent. The
 * projection moves level `z` by `z` cells, so every window that unions the
 * drawn levels grows by this many cells a side; measuring it from the viewer
 * instead of across the whole world is what keeps that cost the same however
 * deep the world goes.
 */
export const VIEW_LEVEL_REACH = 8;

export type LevelRange = { z0: number; z1: number };

export function viewLevels(viewerZ: number): LevelRange {
  return {
    z0: Math.max(MIN_LEVEL, viewerZ - VIEW_LEVEL_REACH),
    z1: Math.min(MAX_LEVEL, viewerZ + VIEW_LEVEL_REACH),
  };
}

/**
 * The light bake's levels move in steps of this many, so climbing a ladder
 * relights the window once every few levels rather than on every one.
 */
const LIGHT_LEVEL_STEP = 4;

/** Always covers {@link viewLevels} of the same viewer. */
export function lightLevels(viewerZ: number): LevelRange {
  const z0 = Math.floor((viewerZ - VIEW_LEVEL_REACH) / LIGHT_LEVEL_STEP) * LIGHT_LEVEL_STEP;
  return {
    z0: Math.max(MIN_LEVEL, z0),
    z1: Math.min(MAX_LEVEL, z0 + 2 * VIEW_LEVEL_REACH + LIGHT_LEVEL_STEP - 1),
  };
}
