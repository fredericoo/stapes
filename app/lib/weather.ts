import { MS_PER_CLOCK_MINUTE, type Illumination } from "./clock";
import { scatterHash } from "./scatter";

export const WEATHER_KINDS = ["clear", "rain", "fog"] as const;

export type WeatherKind = (typeof WEATHER_KINDS)[number];

export function isWeatherKind(value: string): value is WeatherKind {
  return (WEATHER_KINDS as readonly string[]).includes(value);
}

const SPELL_HOURS = 3;
const MINUTES_PER_HOUR = 60;

/** One spell of weather lasts this long; the weather is drawn again for each. */
export const WEATHER_SPELL_MS = SPELL_HOURS * MINUTES_PER_HOUR * MS_PER_CLOCK_MINUTE;

const RAIN_SHARE = 0.2;
const FOG_SHARE = 0.1;
const WEATHER_SEED = 0x7ea73e11;
const UINT32_RANGE = 0x1_0000_0000;

/**
 * The weather the world has at a moment, when nobody has set it by hand. A
 * function of the wall clock alone, like the hour of the day, so it needs no
 * row in the database and a restart does not change it.
 */
export function weatherAt(epochMs: number): WeatherKind {
  const spell = Math.floor(epochMs / WEATHER_SPELL_MS);
  const roll = scatterHash(spell, 0, 0, WEATHER_SEED) / UINT32_RANGE;
  if (roll < RAIN_SHARE) return "rain";
  if (roll < RAIN_SHARE + FOG_SHARE) return "fog";
  return "clear";
}

type Rgb = [number, number, number];

/** What the sky and the sun are multiplied by under each weather. */
const SKY_UNDER: Record<WeatherKind, { ambient: Rgb; sun: number }> = {
  clear: { ambient: [1, 1, 1], sun: 1 },
  rain: { ambient: [0.78, 0.82, 0.92], sun: 0.3 },
  fog: { ambient: [0.85, 0.87, 0.9], sun: 0.3 },
};

export function illuminationUnder(weather: WeatherKind, light: Illumination): Illumination {
  if (weather === "clear") return light;
  const sky = SKY_UNDER[weather];
  return {
    ambient: [
      light.ambient[0] * sky.ambient[0],
      light.ambient[1] * sky.ambient[1],
      light.ambient[2] * sky.ambient[2],
    ],
    sun: [light.sun[0] * sky.sun, light.sun[1] * sky.sun, light.sun[2] * sky.sun],
    sunArc: light.sunArc,
  };
}

/** How many cells from the viewer fog leaves clear, and how many more it takes to close. */
export const FOG_CLEAR_CELLS = 2;
export const FOG_FADE_CELLS = 7;

/** The sky factor of a cell under open sky is 1, and each step under cover takes a fifteenth off it. */
export const OPEN_SKY_FACTOR = 0.9;

/** Below ground, fog is whole where the sky factor is at least this and thins to nothing at 0. */
export const FOG_SKY_FULL = 0.35;

/**
 * Light from a torch, a lamp or a fire burns a hole in fog: none of it where
 * the cell's own light is `FOG_LIGHT_FROM` or less, all of it at `FOG_LIGHT_TO`.
 * The light is the brightest channel, 0 to 1, of the cell and its four
 * neighbours, so the wall beside a lamp clears with the floor in front of it.
 */
export const FOG_LIGHT_FROM = 0.25;
export const FOG_LIGHT_TO = 0.7;

/**
 * How far through the fade a cell is taken as hidden. The palette pass snaps a
 * half-fogged pixel to the fog's colour, so a body is gone from the picture
 * well before the fog over it is whole, and its name has to go with it.
 */
const FOG_HIDES_FROM = 0.5;

export const FOG_HIDES_CELLS = FOG_CLEAR_CELLS + FOG_FADE_CELLS * FOG_HIDES_FROM;

/** `skyFactor` matters only below ground: from ground level up fog covers a cell whatever its sky. */
export function fogHidesAt(
  cellsFromViewer: number,
  z: number,
  skyFactor: number,
  light = 0,
): boolean {
  if (cellsFromViewer < FOG_HIDES_CELLS) return false;
  if (light > FOG_LIGHT_FROM) return false;
  return z >= 0 || skyFactor >= FOG_SKY_FULL;
}
