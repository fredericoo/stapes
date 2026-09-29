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
  hint: string;
}> = [
  { id: "house", label: "House", hint: "Build a house from a dragged rectangle" },
  { id: "cave", label: "Cave", hint: "Carve a cave out of a dragged rectangle" },
  { id: "forest", label: "Forest", hint: "Grow a forest over a dragged rectangle" },
];

export type ProceduralSettings = {
  active: GeneratorId;
  house: HouseConfig;
  cave: CaveConfig;
  forest: ForestConfig;
};

export function activeConfig(settings: ProceduralSettings): ProceduralConfig {
  return settings[settings.active];
}

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
