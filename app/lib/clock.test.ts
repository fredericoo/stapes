import { describe, expect, it } from "vitest";
import {
  clockAfter,
  formatClock,
  MINUTES_PER_DAY,
  minutesOfDayAt,
  MS_PER_CLOCK_MINUTE,
  sampleIllumination,
  SUNRISE_MINUTES,
  SUNSET_MINUTES,
  sunArcAt,
  wrapMinutes,
  type IlluminationKeyframe,
} from "./clock";

describe("wrapMinutes", () => {
  it("wraps past midnight and negative", () => {
    expect(wrapMinutes(0)).toBe(0);
    expect(wrapMinutes(MINUTES_PER_DAY)).toBe(0);
    expect(wrapMinutes(MINUTES_PER_DAY + 30)).toBe(30);
    expect(wrapMinutes(-1)).toBe(MINUTES_PER_DAY - 1);
  });
});

describe("formatClock", () => {
  it("formats HH:MM", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(12 * 60 + 5)).toBe("12:05");
    expect(formatClock(23 * 60 + 59)).toBe("23:59");
  });
});

describe("sampleIllumination", () => {
  const keys: IlluminationKeyframe[] = [
    { at: 0, ambient: [0, 0, 0] },
    { at: 12 * 60, ambient: [1, 1, 1] },
  ];

  it("hits keyframes exactly", () => {
    expect(sampleIllumination(0, keys).ambient).toEqual([0, 0, 0]);
    expect(sampleIllumination(12 * 60, keys).ambient).toEqual([1, 1, 1]);
  });

  it("lerps midpoint", () => {
    const mid = sampleIllumination(6 * 60, keys);
    expect(mid.ambient[0]).toBeCloseTo(0.5, 5);
  });

  it("wraps midnight", () => {
    const dusk = sampleIllumination(18 * 60, keys);
    expect(dusk.ambient[0]).toBeCloseTo(0.5, 5);
  });

  it("adds sun to sky to reach full light through the middle of the day", () => {
    for (const h of [10, 12, 16]) {
      const { ambient, sun } = sampleIllumination(h * 60);
      for (let c = 0; c < 3; c++) expect(ambient[c]! + sun[c]!).toBeGreaterThan(0.95);
    }
  });

  it("keeps a shadow visibly darker and bluer than sunlight at noon", () => {
    const { ambient, sun } = sampleIllumination(12 * 60);
    expect(ambient[0]).toBeLessThan(0.6);
    expect(ambient[2]).toBeGreaterThan(ambient[0]);
    expect(sun[0]).toBeGreaterThan(sun[2]);
  });

  it("holds night from 00:00 through 04:00 with no sun", () => {
    for (const h of [0, 2, 4]) {
      const { ambient, sun } = sampleIllumination(h * 60);
      expect(ambient).toEqual([0.04, 0.05, 0.1]);
      expect(sun).toEqual([0, 0, 0]);
    }
  });

  it("tints early morning sun yellow and sunset sun red", () => {
    const morning = sampleIllumination(7 * 60).sun;
    expect(morning[1]).toBeGreaterThan(morning[2] * 1.5);
    const sunset = sampleIllumination(19 * 60 + 30).sun;
    expect(sunset[0]).toBeGreaterThan(sunset[1] * 2);
  });

  it("turns the sky blue and darker from sunset to midnight", () => {
    const dusk = sampleIllumination(21 * 60);
    expect(dusk.ambient[2]).toBeGreaterThan(dusk.ambient[0]);
    expect(dusk.sun).toEqual([0, 0, 0]);
    const late = sampleIllumination(23 * 60).ambient;
    expect(late[2]).toBeLessThan(dusk.ambient[2]);
  });
});

describe("sunArcAt", () => {
  it("runs from the eastern horizon at sunrise to the western at sunset", () => {
    expect(sunArcAt(SUNRISE_MINUTES)).toBe(0);
    expect(sunArcAt((SUNRISE_MINUTES + SUNSET_MINUTES) / 2)).toBeCloseTo(0.5, 5);
    expect(sunArcAt(SUNSET_MINUTES)).toBe(1);
  });

  it("clamps through the night", () => {
    expect(sunArcAt(2 * 60)).toBe(0);
    expect(sunArcAt(23 * 60)).toBe(1);
  });
});

describe("clockAfter", () => {
  it("runs one clock minute per real second", () => {
    expect(clockAfter(0, MS_PER_CLOCK_MINUTE)).toBe(1);
    expect(clockAfter(0, 60 * MS_PER_CLOCK_MINUTE)).toBe(60);
  });

  it("wraps past midnight", () => {
    expect(clockAfter(MINUTES_PER_DAY - 1, MS_PER_CLOCK_MINUTE)).toBe(0);
  });
});

describe("minutesOfDayAt", () => {
  it("is the same reading for the same instant", () => {
    const now = 1_770_000_000_000;
    expect(minutesOfDayAt(now)).toBe(minutesOfDayAt(now));
  });

  it("advances a minute per real second and a day per 24 real minutes", () => {
    const now = 1_770_000_000_000;
    expect(minutesOfDayAt(now + MS_PER_CLOCK_MINUTE)).toBe(wrapMinutes(minutesOfDayAt(now) + 1));
    expect(minutesOfDayAt(now + MINUTES_PER_DAY * MS_PER_CLOCK_MINUTE)).toBe(minutesOfDayAt(now));
  });
});
