import { describe, expect, it } from "vitest";
import {
  clockAfter,
  formatClock,
  MINUTES_PER_DAY,
  minutesOfDayAt,
  MS_PER_CLOCK_MINUTE,
  sampleIllumination,
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
    { at: 0, ambient: [0, 0, 0], background: 0x000000 },
    { at: 12 * 60, ambient: [1, 1, 1], background: 0xffffff },
  ];

  it("hits keyframes exactly", () => {
    expect(sampleIllumination(0, keys).ambient).toEqual([0, 0, 0]);
    expect(sampleIllumination(12 * 60, keys).ambient).toEqual([1, 1, 1]);
  });

  it("lerps midpoint", () => {
    const mid = sampleIllumination(6 * 60, keys);
    expect(mid.ambient[0]).toBeCloseTo(0.5, 5);
    expect(mid.background).toBe(0x808080);
  });

  it("wraps midnight", () => {
    // Halfway from noon white → midnight black via wrap: at 18:00 is mid
    // of 12:00→00:00 span (12h). From 12:00 to 00:00 is 12h; 18:00 is 6h in.
    const dusk = sampleIllumination(18 * 60, keys);
    expect(dusk.ambient[0]).toBeCloseTo(0.5, 5);
  });

  it("matches day/dusk/night character of default keyframes", () => {
    const noon = sampleIllumination(12 * 60);
    expect(noon.ambient[0]).toBeCloseTo(1, 5);

    const dusk = sampleIllumination(17 * 60);
    expect(dusk.ambient[0]).toBeCloseTo(0.55, 5);
    expect(sampleIllumination(18 * 60).ambient[0]).toBeCloseTo(0.55, 5);

    const night = sampleIllumination(0);
    expect(night.ambient[0]).toBeCloseTo(0.04, 5);
  });

  it("holds day from 09:00 through 16:00", () => {
    for (const h of [9, 12, 16]) {
      const { ambient } = sampleIllumination(h * 60);
      expect(ambient[0]).toBeCloseTo(1, 5);
      expect(ambient[1]).toBeCloseTo(1, 5);
      expect(ambient[2]).toBeCloseTo(1, 5);
    }
    // Mid day→dusk and dusk→night blends
    expect(sampleIllumination(16 * 60 + 30).ambient[0]).toBeCloseTo(0.775, 2);
    expect(sampleIllumination(18 * 60 + 30).ambient[0]).toBeCloseTo(0.295, 2);
  });

  it("holds night from 19:00 through 04:00", () => {
    for (const h of [19, 22, 0, 2, 4]) {
      const { ambient } = sampleIllumination(h * 60);
      expect(ambient[0]).toBeCloseTo(0.04, 5);
      expect(ambient[1]).toBeCloseTo(0.05, 5);
      expect(ambient[2]).toBeCloseTo(0.1, 5);
    }
    // Dawn has started by 06:00
    expect(sampleIllumination(6 * 60).ambient[0]).toBeGreaterThan(0.2);
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
  /**
   * The property the shared clock rests on: any two readings of the same
   * instant agree, and the gap between two instants is real time at the game
   * rate. This is what makes a client able to anchor once and stay in step
   * without the server sending the time again.
   */
  it("is the same reading for the same instant", () => {
    const now = 1_770_000_000_000;
    expect(minutesOfDayAt(now)).toBe(minutesOfDayAt(now));
  });

  it("advances a minute per real second and a day per 24 real minutes", () => {
    const now = 1_770_000_000_000;
    expect(minutesOfDayAt(now + MS_PER_CLOCK_MINUTE)).toBe(
      wrapMinutes(minutesOfDayAt(now) + 1),
    );
    expect(minutesOfDayAt(now + MINUTES_PER_DAY * MS_PER_CLOCK_MINUTE)).toBe(
      minutesOfDayAt(now),
    );
  });
});
