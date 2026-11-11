import { describe, expect, it } from "vitest";
import {
  fogReachAt,
  parseWeatherAreas,
  weatherAreasIn,
  weatherReaches,
  type WeatherArea,
} from "./weatherAreas";

const area = (x0: number, y0: number, x1: number, y1: number, rain: boolean, fog: boolean) => ({
  x0,
  y0,
  x1,
  y1,
  rain,
  fog,
});

describe("weatherReaches", () => {
  const everywhere = area(-100, -100, 100, 100, true, false);
  const desert = area(10, 10, 20, 20, false, false);
  const swamp = area(-20, -20, -10, -10, true, true);
  const areas: WeatherArea[] = [everywhere, desert, swamp];

  it("lets every kind reach a cell that no area covers", () => {
    expect(weatherReaches([desert], "rain", 0, 0)).toBe(true);
    expect(weatherReaches([desert], "fog", 0, 0)).toBe(true);
  });

  it("asks the last area that covers the cell, corners included", () => {
    expect(weatherReaches(areas, "rain", 0, 0)).toBe(true);
    expect(weatherReaches(areas, "fog", 0, 0)).toBe(false);
    expect(weatherReaches(areas, "rain", 10, 20)).toBe(false);
    expect(weatherReaches(areas, "rain", 9, 20)).toBe(true);
    expect(weatherReaches(areas, "fog", -15, -15)).toBe(true);
  });
});

describe("weatherAreasIn", () => {
  it("keeps the last areas when more touch the window than fit", () => {
    const stacked = [0, 1, 2, 3].map((i) => area(0, 0, i, i, i % 2 === 0, false));
    expect(weatherAreasIn(stacked, { x0: 0, y0: 0, x1: 5, y1: 5 }, 2)).toEqual(stacked.slice(2));
  });

  it("leaves out an area the window does not touch", () => {
    const far = area(50, 50, 60, 60, false, false);
    expect(weatherAreasIn([far], { x0: 0, y0: 0, x1: 49, y1: 49 }, 8)).toEqual([]);
  });
});

describe("parseWeatherAreas", () => {
  it("puts the corners of a rectangle drawn backwards the right way round", () => {
    expect(parseWeatherAreas([area(5, 7, 1, 2, true, true)])).toEqual([
      area(1, 2, 5, 7, true, true),
    ]);
  });

  it("reads a document that is not a list of areas as none", () => {
    expect(parseWeatherAreas({ areas: [] })).toEqual([]);
    expect(parseWeatherAreas([{ x0: 0 }])).toEqual([]);
  });
});

describe("fogReachAt", () => {
  const clearEast = [area(0, -100, 100, 100, true, false)];

  it("thickens from nothing at an area's edge to all of it a few cells in", () => {
    const along = [2, 0, -1, -3, -5].map((x) => fogReachAt(clearEast, x, 0));
    expect(along[0]).toBeLessThan(along[1]!);
    expect(along[1]).toBeLessThan(along[2]!);
    expect(along[2]).toBeLessThan(along[3]!);
    expect(along[4]).toBe(1);
  });

  it("is all of it everywhere when there are no areas", () => {
    expect(fogReachAt([], 0, 0)).toBe(1);
  });
});
