import * as v from "valibot";
import type { WeatherKind } from "./weather";

/**
 * A rectangle of cells, both corners included, on every level, and the weather
 * that reaches it. Where rectangles overlap the later one in the list decides,
 * and a cell in none of them gets every kind of weather.
 */
export type WeatherArea = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rain: boolean;
  fog: boolean;
};

export const MAX_WEATHER_AREAS = 64;

const cell = v.pipe(v.number(), v.integer());

const weatherAreaSchema = v.pipe(
  v.object({ x0: cell, y0: cell, x1: cell, y1: cell, rain: v.boolean(), fog: v.boolean() }),
  v.transform((area) => ({
    ...area,
    x0: Math.min(area.x0, area.x1),
    y0: Math.min(area.y0, area.y1),
    x1: Math.max(area.x0, area.x1),
    y1: Math.max(area.y0, area.y1),
  })),
);

export const weatherAreasSchema = v.pipe(
  v.array(weatherAreaSchema),
  v.maxLength(MAX_WEATHER_AREAS),
);

/** The areas in a stored document, or none when it is missing or not one. */
export function parseWeatherAreas(raw: unknown): WeatherArea[] {
  const parsed = v.safeParse(weatherAreasSchema, raw);
  return parsed.success ? parsed.output : [];
}

function covers(area: WeatherArea, x: number, y: number): boolean {
  return x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
}

export function weatherReaches(
  areas: readonly WeatherArea[],
  weather: WeatherKind,
  x: number,
  y: number,
): boolean {
  if (weather === "clear") return true;
  for (let i = areas.length - 1; i >= 0; i--) {
    const area = areas[i]!;
    if (covers(area, x, y)) return area[weather];
  }
  return true;
}

/** Fog is asked for at a cell and at one and two of these steps to each side of it; see `fogReachAt`. */
export const FOG_EDGE_STEP_CELLS = 2;

const FOG_EDGE_RINGS = 2;

/**
 * How much of the fog reaches a cell, 0 to 1: the share of the cell and the
 * cells round it that fog reaches, so fog thickens over a few cells inside an
 * area's edge. The world shader's `fogReach` is the same sum.
 */
export function fogReachAt(areas: readonly WeatherArea[], x: number, y: number): number {
  if (areas.length === 0) return 1;
  let reached = weatherReaches(areas, "fog", x, y) ? 1 : 0;
  for (let ring = 1; ring <= FOG_EDGE_RINGS; ring++) {
    const d = ring * FOG_EDGE_STEP_CELLS;
    for (const [dx, dy] of [
      [d, 0],
      [-d, 0],
      [0, d],
      [0, -d],
    ] as const) {
      if (weatherReaches(areas, "fog", x + dx, y + dy)) reached++;
    }
  }
  return reached / (1 + FOG_EDGE_RINGS * 4);
}

export type CellRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * The areas that touch `window`, in their own order, and at most `limit` of
 * them: the last ones, because a later area decides over an earlier one.
 */
export function weatherAreasIn(
  areas: readonly WeatherArea[],
  window: CellRect,
  limit: number,
): WeatherArea[] {
  const touching = areas.filter(
    (area) =>
      area.x1 >= window.x0 && area.x0 <= window.x1 && area.y1 >= window.y0 && area.y0 <= window.y1,
  );
  return touching.length > limit ? touching.slice(touching.length - limit) : touching;
}
