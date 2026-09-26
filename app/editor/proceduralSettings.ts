import * as v from "valibot";
import { MAX_SCATTER_RULES } from "./generator";
import { CAVE_DENSITY_RANGE, type CaveConfig, type CaveShape } from "./cave";
import {
  FOREST_DENSITY_RANGE,
  PATH_COUNT_RANGE,
  PATH_WIDTH_RANGE,
  type ForestConfig,
} from "./forest";
import { ROOF_COLOUR_IDS, WINDOW_SPACING_RANGE, type HouseConfig, type RoofColour } from "./house";
import type { GeneratorId, ProceduralSettings } from "./procedural";

const STORAGE_KEY = "stapes:procedural:v2";

const MAX_STOREYS = 8;

const DEFAULT_WINDOW_SPACING = 4;

export const DEFAULT_HOUSE_CONFIG: HouseConfig = {
  generator: "house",
  storeys: 1,
  roofOrientation: "auto",
  roofColour: "red",
  wallTileId: "sw2",
  floorTileId: "wooden-floor",
  windowTileId: "window-1",
  windowSpacing: DEFAULT_WINDOW_SPACING,
  doorTileId: "door-closed",
  doorRow: "south",
  doorColumn: "centre",
};

export const DEFAULT_CAVE_CONFIG: CaveConfig = {
  generator: "cave",
  seed: 0x5ea11ce,
  shape: "caverns",
  density: 50,
  wallTileId: "half-stone",
  ledgeTileId: "half-stone",
  ledgeChance: 20,
  floorTileId: "dirt",
  accentFloorTileId: null,
  accentCoverage: 25,
  waterTileId: null,
  waterCoverage: 12,
  scatter: [],
};

export const DEFAULT_FOREST_CONFIG: ForestConfig = {
  generator: "forest",
  seed: 0xf07e57,
  density: 55,
  groundTileId: "grass-2",
  treeTileId: "tree",
  paths: 1,
  pathWidth: 2,
  pathTileId: "dirt",
  waterTileId: null,
  waterCoverage: 8,
  scatter: [{ tileId: "small-bush", chancePercent: 4 }],
};

export const DEFAULT_PROCEDURAL_SETTINGS: ProceduralSettings = {
  active: "house",
  house: DEFAULT_HOUSE_CONFIG,
  cave: DEFAULT_CAVE_CONFIG,
  forest: DEFAULT_FOREST_CONFIG,
};

export const STOREY_RANGE = { min: 1, max: MAX_STOREYS } as const;

const PercentSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100));

const ScatterSchema = v.pipe(
  v.array(v.object({ tileId: v.string(), chancePercent: PercentSchema })),
  v.maxLength(MAX_SCATTER_RULES),
);

const HouseConfigSchema = v.object({
  generator: v.literal("house"),
  storeys: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_STOREYS)),
  roofOrientation: v.picklist(["auto", "vertical", "horizontal"]),
  roofColour: v.nullable(v.picklist(ROOF_COLOUR_IDS as [RoofColour, ...RoofColour[]])),
  wallTileId: v.string(),
  floorTileId: v.string(),
  windowTileId: v.nullable(v.string()),
  windowSpacing: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(WINDOW_SPACING_RANGE.min),
      v.maxValue(WINDOW_SPACING_RANGE.max),
    ),
    DEFAULT_WINDOW_SPACING,
  ),
  doorTileId: v.nullable(v.string()),
  doorRow: v.picklist(["north", "centre", "south"]),
  doorColumn: v.picklist(["west", "centre", "east"]),
});

const CaveConfigSchema = v.object({
  generator: v.literal("cave"),
  seed: v.pipe(v.number(), v.integer()),
  shape: v.picklist(["caverns", "veins", "tunnels"] as [CaveShape, ...CaveShape[]]),
  density: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(CAVE_DENSITY_RANGE.min),
    v.maxValue(CAVE_DENSITY_RANGE.max),
  ),
  wallTileId: v.string(),
  ledgeTileId: v.nullable(v.string()),
  ledgeChance: PercentSchema,
  floorTileId: v.string(),
  accentFloorTileId: v.nullable(v.string()),
  accentCoverage: PercentSchema,
  waterTileId: v.nullable(v.string()),
  waterCoverage: PercentSchema,
  scatter: ScatterSchema,
});

const ForestConfigSchema = v.object({
  generator: v.literal("forest"),
  seed: v.pipe(v.number(), v.integer()),
  density: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(FOREST_DENSITY_RANGE.min),
    v.maxValue(FOREST_DENSITY_RANGE.max),
  ),
  groundTileId: v.string(),
  treeTileId: v.string(),
  paths: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(PATH_COUNT_RANGE.min),
    v.maxValue(PATH_COUNT_RANGE.max),
  ),
  pathWidth: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(PATH_WIDTH_RANGE.min),
    v.maxValue(PATH_WIDTH_RANGE.max),
  ),
  pathTileId: v.nullable(v.string()),
  waterTileId: v.nullable(v.string()),
  waterCoverage: PercentSchema,
  scatter: ScatterSchema,
});

const SettingsSchema = v.object({
  active: v.picklist(["house", "cave", "forest"] as [GeneratorId, ...GeneratorId[]]),
  house: v.unknown(),
  cave: v.unknown(),
  forest: v.unknown(),
});

type KnownTileId = (id: string) => boolean;

function keptOptionalTile(id: string | null, known: KnownTileId): string | null {
  return id && known(id) ? id : null;
}

function readHouse(raw: unknown, known: KnownTileId): HouseConfig {
  const parsed = v.safeParse(HouseConfigSchema, raw);
  if (!parsed.success) return DEFAULT_HOUSE_CONFIG;
  const config = parsed.output;
  if (!known(config.wallTileId) || !known(config.floorTileId)) {
    return DEFAULT_HOUSE_CONFIG;
  }
  return {
    ...config,
    windowTileId: keptOptionalTile(config.windowTileId, known),
    doorTileId: keptOptionalTile(config.doorTileId, known),
  };
}

function readForest(raw: unknown, known: KnownTileId): ForestConfig {
  const parsed = v.safeParse(ForestConfigSchema, raw);
  if (!parsed.success) return DEFAULT_FOREST_CONFIG;
  const config = parsed.output;
  if (!known(config.groundTileId) || !known(config.treeTileId)) {
    return DEFAULT_FOREST_CONFIG;
  }
  return {
    ...config,
    pathTileId: keptOptionalTile(config.pathTileId, known),
    waterTileId: keptOptionalTile(config.waterTileId, known),
    scatter: config.scatter.filter((rule) => known(rule.tileId)),
  };
}

function readCave(raw: unknown, known: KnownTileId): CaveConfig {
  const parsed = v.safeParse(CaveConfigSchema, raw);
  if (!parsed.success) return DEFAULT_CAVE_CONFIG;
  const config = parsed.output;
  if (!known(config.wallTileId) || !known(config.floorTileId)) {
    return DEFAULT_CAVE_CONFIG;
  }
  return {
    ...config,
    ledgeTileId: keptOptionalTile(config.ledgeTileId, known),
    accentFloorTileId: keptOptionalTile(config.accentFloorTileId, known),
    waterTileId: keptOptionalTile(config.waterTileId, known),
    scatter: config.scatter.filter((rule) => known(rule.tileId)),
  };
}

export function loadProceduralSettings(known: KnownTileId): ProceduralSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROCEDURAL_SETTINGS;
    const parsed = v.safeParse(SettingsSchema, JSON.parse(raw));
    if (!parsed.success) return DEFAULT_PROCEDURAL_SETTINGS;
    return {
      active: parsed.output.active,
      house: readHouse(parsed.output.house, known),
      cave: readCave(parsed.output.cave, known),
      forest: readForest(parsed.output.forest, known),
    };
  } catch {
    return DEFAULT_PROCEDURAL_SETTINGS;
  }
}

export function saveProceduralSettings(settings: ProceduralSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}
