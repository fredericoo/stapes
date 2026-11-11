import { describe, expect, it } from "vitest";
import {
  FOG_HIDES_CELLS,
  WEATHER_KINDS,
  WEATHER_SPELL_MS,
  fogHidesAt,
  illuminationUnder,
  weatherAt,
} from "./weather";

describe("weatherAt", () => {
  it("holds one weather for a whole spell", () => {
    for (let spell = 0; spell < 50; spell++) {
      const start = spell * WEATHER_SPELL_MS;
      expect(weatherAt(start + WEATHER_SPELL_MS - 1)).toBe(weatherAt(start));
    }
  });

  it("brings every kind round, and clear skies most often", () => {
    const counts = { clear: 0, rain: 0, fog: 0 };
    for (let spell = 0; spell < 2_000; spell++) counts[weatherAt(spell * WEATHER_SPELL_MS)]++;
    for (const kind of WEATHER_KINDS) expect(counts[kind]).toBeGreaterThan(0);
    expect(counts.clear).toBeGreaterThan(counts.rain + counts.fog);
  });
});

describe("illuminationUnder", () => {
  const noon = { ambient: [0.5, 0.54, 0.62], sun: [0.55, 0.5, 0.42], sunArc: 0.5 } as const;

  it("dims the sun under rain and leaves its place in the sky alone", () => {
    const light = { ambient: [...noon.ambient], sun: [...noon.sun], sunArc: noon.sunArc } as never;
    const wet = illuminationUnder("rain", light);
    expect(wet.sun[0]).toBeLessThan(noon.sun[0]);
    expect(wet.sunArc).toBe(noon.sunArc);
    expect(illuminationUnder("clear", light)).toBe(light);
  });
});

describe("fogHidesAt", () => {
  const closed = FOG_HIDES_CELLS;

  it("hides a cell once the fog has closed, and not before", () => {
    expect(fogHidesAt(closed, 0, 1)).toBe(true);
    expect(fogHidesAt(closed - 1, 0, 1)).toBe(false);
  });

  it("hides a cell on the surface that has no sky of its own, such as one under a tree", () => {
    expect(fogHidesAt(closed, 0, 0)).toBe(true);
  });

  it("hides nothing that stands in a lamp's light", () => {
    expect(fogHidesAt(closed, 0, 1, 0.4)).toBe(false);
  });

  it("hides nothing in a cave, however far, and does hide the floor of an open pit", () => {
    expect(fogHidesAt(closed * 3, -1, 0)).toBe(false);
    expect(fogHidesAt(closed, -1, 1)).toBe(true);
  });
});
