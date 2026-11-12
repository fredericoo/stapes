import { stackOcclusion } from "../lib/lighting";
import { getStack, presentLevels } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";
import type { WeatherKind } from "../lib/weather";
import { weatherReaches, type WeatherArea } from "../lib/weatherAreas";

export type Sky = { weather: WeatherKind; areas: readonly WeatherArea[] };

export const CLEAR_SKY: Sky = { weather: "clear", areas: [] };

/**
 * The same column walk as the light bake's sky shaft, so rain reacts where the
 * world shader draws it: a stack on any level above seals the column once it
 * holds one tile light does not pass or one raised off its floor.
 */
export function underOpenSky(map: MapFile, at: Coord, tilesById: Record<string, TileDef>): boolean {
  for (const z of presentLevels(map)) {
    if (z <= at.z) continue;
    const stack = getStack(map, at.x, at.y, z);
    if (stack.length > 0 && stackOcclusion(stack, tilesById).sealsLevel) return false;
  }
  return true;
}

/** What the sky is doing over a cell, whether or not anything stands between them. */
export function weatherOver(sky: Sky, at: Coord): WeatherKind {
  if (sky.weather === "clear") return "clear";
  return weatherReaches(sky.areas, sky.weather, at.x, at.y) ? sky.weather : "clear";
}

/**
 * What reaches the cell itself. Rain needs open sky; fog covers every cell
 * from ground level up and asks the sky only below it, as the shader does.
 */
export function weatherOn(
  map: MapFile,
  sky: Sky,
  at: Coord,
  tilesById: Record<string, TileDef>,
): WeatherKind {
  const over = weatherOver(sky, at);
  if (over === "clear") return "clear";
  if (over === "fog" && at.z >= 0) return "fog";
  return underOpenSky(map, at, tilesById) ? over : "clear";
}
