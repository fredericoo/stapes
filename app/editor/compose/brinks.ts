import type { PlacedTile, TileDef } from "../../lib/types";
import { TILES } from "./field";

/**
 * The brink each kind of flat ground is cut to at the top of a cliff. A brink
 * is that ground drawn to the outline of the wall under it, so a cell beside
 * a drop shows its ground's brink in place of the ground and every cover on it.
 */
const BRINK_OF: Readonly<Record<string, string>> = {
  grass: "grass-brink",
  "grass-2": "grass-brink",
  sand: "sand-brink",
  "beach-sand": "sand-brink",
  snow: "snow-brink",
  basalt: "basalt-brink",
};

const GROUND_OF: Readonly<Record<string, string>> = {
  "grass-brink": "grass-2",
  "sand-brink": "sand",
  "snow-brink": "snow",
  "basalt-brink": "basalt",
};

export const brinkOf = (ground: string): string | undefined => BRINK_OF[ground];

export const isBrink = (id: string | undefined): boolean => id !== undefined && id in GROUND_OF;

/** The ground a brink is cut from, so a layer that asks for sand finds it on a sand brink. */
export const groundOf = (id: string): string => GROUND_OF[id] ?? id;

export const isFlat = (p: PlacedTile, tilesById: Readonly<Record<string, TileDef>>): boolean => {
  const def = tilesById[p.tileId];
  return def !== undefined && TILES.ground.test(def);
};
