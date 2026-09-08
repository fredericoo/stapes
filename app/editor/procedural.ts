/**
 * The generators the procedural tool offers, and the one call that runs them.
 *
 * Each generator is its own module and knows nothing about the others; this is
 * the list they are reached through. Adding one is a config type with a
 * `generator` tag, a `plan*` function, a row in {@link GENERATORS}, a default
 * in `./proceduralSettings` and a form in the dialog — and nothing in the
 * store or the renderer, both of which only ever see {@link planProcedural}.
 */

import type { MapFile, TileDef } from "../lib/types";
import { planCave, type CaveConfig } from "./cave";
import { planForest, type ForestConfig } from "./forest";
import type { GeneratedPlan, Rect } from "./generator";
import { planHouse, type HouseConfig } from "./house";

export type ProceduralConfig = HouseConfig | CaveConfig | ForestConfig;

export type GeneratorId = ProceduralConfig["generator"];

export const GENERATORS: Array<{
  id: GeneratorId;
  label: string;
  /** Shown on the tool button, and it has to say what a drag will do. */
  hint: string;
}> = [
  { id: "house", label: "House", hint: "Build a house from a dragged rectangle" },
  { id: "cave", label: "Cave", hint: "Carve a cave out of a dragged rectangle" },
  { id: "forest", label: "Forest", hint: "Grow a forest over a dragged rectangle" },
];

/**
 * Every generator's settings at once, and which of them is armed.
 *
 * Kept together rather than one at a time because switching generators in the
 * dialog to look at what a cave would do should not lose the house that was
 * set up before it.
 */
export type ProceduralSettings = {
  active: GeneratorId;
  house: HouseConfig;
  cave: CaveConfig;
  forest: ForestConfig;
};

export function activeConfig(settings: ProceduralSettings): ProceduralConfig {
  return settings[settings.active];
}

/**
 * What the armed generator would build over `rect` on level `z`, or the reason
 * it cannot. `z` is the editor's current level.
 */
export function planProcedural(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  rect: Rect,
  z: number,
  config: ProceduralConfig,
): GeneratedPlan {
  if (config.generator === "house") {
    return planHouse(map, tilesById, rect, z, config);
  }
  if (config.generator === "cave") {
    return planCave(map, tilesById, rect, z, config);
  }
  return planForest(map, tilesById, rect, z, config);
}
