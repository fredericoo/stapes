/**
 * The last settings the procedural dialog was placed with, kept in the browser.
 *
 * A generator's settings are how somebody is building *right now* — a row of
 * blue-roofed cottages is nine placements of one form — so they belong to the
 * person rather than to the map, which is why they are here and not in
 * `data/map.json`. Parsed rather than trusted on the way in: the value survives
 * a deploy that renamed a tile or dropped a colour, and a stale one should read
 * as "no saved settings" instead of arming the tool with a tile id that no
 * longer exists.
 */

import * as v from "valibot";
import {
  ROOF_COLOUR_IDS,
  WINDOW_SPACING_RANGE,
  type HouseConfig,
  type RoofColour,
} from "./house";

/** Bump when the shape changes so saved settings from before it are dropped. */
const STORAGE_KEY = "stapes:procedural:v1";

const MAX_STOREYS = 8;

/**
 * Four cells between windows, not the two the wall grammar allows at its
 * tightest: at two every other wall cell is glass, which reads as a shopfront
 * rather than as a house, and a five-wide wall ends up with a window either
 * side of its door.
 */
const DEFAULT_WINDOW_SPACING = 4;

export const DEFAULT_HOUSE_CONFIG: HouseConfig = {
  storeys: 1,
  roofOrientation: "vertical",
  roofColour: "red",
  wallTileId: "sw2",
  floorTileId: "wooden-floor",
  windowTileId: "window-1",
  windowSpacing: DEFAULT_WINDOW_SPACING,
  doorTileId: "door-closed",
  doorRow: "south",
  doorColumn: "centre",
};

const HouseConfigSchema = v.object({
  storeys: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_STOREYS),
  ),
  roofOrientation: v.picklist(["vertical", "horizontal"]),
  roofColour: v.picklist(ROOF_COLOUR_IDS as [RoofColour, ...RoofColour[]]),
  wallTileId: v.string(),
  floorTileId: v.string(),
  windowTileId: v.nullable(v.string()),
  // Optional with a fallback rather than required: it was added after the
  // first version of these settings shipped, and settings saved before it
  // should come back with everything else in them intact.
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

export const STOREY_RANGE = { min: 1, max: MAX_STOREYS } as const;

/**
 * The saved settings, or the defaults.
 *
 * `knownTileId` is the catalogue speaking: a saved wall of `brick-wall` is only
 * usable while that tile still exists, and a tool armed with a missing one
 * refuses every placement with a message about the tile rather than about the
 * house.
 */
export function loadHouseConfig(
  knownTileId: (id: string) => boolean,
): HouseConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_HOUSE_CONFIG;
    const parsed = v.safeParse(HouseConfigSchema, JSON.parse(raw));
    if (!parsed.success) return DEFAULT_HOUSE_CONFIG;

    const config = parsed.output;
    if (!knownTileId(config.wallTileId) || !knownTileId(config.floorTileId)) {
      return DEFAULT_HOUSE_CONFIG;
    }
    return {
      ...config,
      windowTileId:
        config.windowTileId && knownTileId(config.windowTileId)
          ? config.windowTileId
          : null,
      doorTileId:
        config.doorTileId && knownTileId(config.doorTileId)
          ? config.doorTileId
          : null,
    };
  } catch {
    // Unparseable, or storage is blocked — the defaults are a working house.
    return DEFAULT_HOUSE_CONFIG;
  }
}

export function saveHouseConfig(config: HouseConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage blocked or full: the settings just won't survive a reload.
  }
}
