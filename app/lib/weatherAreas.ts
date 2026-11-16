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

/** Fog fades in over this many cells to each side of an area's edge; see `fogReachAt`. */
export const FOG_EDGE_CELLS = 3;

/** How far, in cells, the fog's edge wanders in and out of an area's straight side. */
export const FOG_EDGE_WOBBLE_CELLS = 0.75;

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Two slow sine waves across the map, so an edge reads as a bank of fog rather than a ruled line. */
function fogEdgeWobble(x: number, y: number): number {
  return FOG_EDGE_WOBBLE_CELLS * (Math.sin(x * 0.53 + y * 0.21) + Math.sin(y * 0.47 - x * 0.19));
}

/**
 * How much of the fog reaches a point in cell space, 0 to 1. Each area is laid
 * over the ones before it with a soft edge, from none of it `FOG_EDGE_CELLS`
 * outside its side to all of it as far inside, so overlapping areas still let
 * the later one decide. The world shader's `fogReach` is the same sum.
 */
export function fogReachAt(areas: readonly WeatherArea[], x: number, y: number): number {
  if (areas.length === 0) return 1;
  const px = x + 0.5;
  const py = y + 0.5;
  const wobble = fogEdgeWobble(px, py);
  let reach = 1;
  for (const area of areas) {
    const hx = (area.x1 + 1 - area.x0) / 2;
    const hy = (area.y1 + 1 - area.y0) / 2;
    const qx = Math.abs(px - (area.x0 + hx)) - hx;
    const qy = Math.abs(py - (area.y0 + hy)) - hy;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    const cover = smoothstep(-FOG_EDGE_CELLS, FOG_EDGE_CELLS, wobble - outside);
    reach = reach * (1 - cover) + (area.fog ? cover : 0);
  }
  return reach;
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
