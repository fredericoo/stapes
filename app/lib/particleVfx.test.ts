import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  compileRamp,
  DEFAULT_PARTICLES,
  EMPTY_SHAPE,
  particleEmitterSchema,
  RAMP_LUT_SIZE,
  rampIndexAt,
  shapeHas,
  toggleShapePixel,
} from "./particleVfx";
import { hexToRgb01 } from "./palette";

const lut = (stops: { at: number; color: string }[], t: number) => {
  const compiled = compileRamp(stops);
  const base = rampIndexAt(t) * 3;
  return [compiled[base]!, compiled[base + 1]!, compiled[base + 2]!] as const;
};

const near = (a: number, b: number, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

describe("a colour ramp", () => {
  it("holds one stop's colour for the whole life", () => {
    const stops = [{ at: 0, color: "#1ebc73" }];
    const [r, g, b] = hexToRgb01("#1ebc73");
    for (const t of [0, 0.5, 1]) {
      const [lr, lg, lb] = lut(stops, t);
      expect(near(lr, r)).toBe(true);
      expect(near(lg, g)).toBe(true);
      expect(near(lb, b)).toBe(true);
    }
  });

  it("reaches each authored stop at the moment it is authored for", () => {
    const stops = [
      { at: 0, color: "#ffffff" },
      { at: 0.5, color: "#e83b3b" },
      { at: 1, color: "#313638" },
    ];
    for (const stop of stops) {
      const [lr, lg, lb] = lut(stops, stop.at);
      const [r, g, b] = hexToRgb01(stop.color);
      expect(near(lr, r)).toBe(true);
      expect(near(lg, g)).toBe(true);
      expect(near(lb, b)).toBe(true);
    }
  });

  it("holds the ends beyond the outermost stops", () => {
    const stops = [
      { at: 0.25, color: "#ffffff" },
      { at: 0.75, color: "#2e222f" },
    ];
    const holdsAt = (t: number, hex: string) => {
      const [lr, lg, lb] = lut(stops, t);
      const [r, g, b] = hexToRgb01(hex);
      expect(near(lr, r)).toBe(true);
      expect(near(lg, g)).toBe(true);
      expect(near(lb, b)).toBe(true);
    };
    holdsAt(0, "#ffffff");
    holdsAt(0.1, "#ffffff");
    holdsAt(1, "#2e222f");
  });

  it("sorts stops rather than trusting their order", () => {
    const ordered = [
      { at: 0, color: "#ffffff" },
      { at: 1, color: "#2e222f" },
    ];
    const jumbled = [
      { at: 1, color: "#2e222f" },
      { at: 0, color: "#ffffff" },
    ];
    expect(compileRamp(jumbled)).toEqual(compileRamp(ordered));
  });

  it("passes through a midpoint lighter than the sRGB average", () => {
    const stops = [
      { at: 0, color: "#ffffff" },
      { at: 1, color: "#fb6b1d" },
    ];
    const [r, g, b] = lut(stops, 0.5);
    const [wr, wg, wb] = hexToRgb01("#ffffff");
    const [ar, ag, ab] = hexToRgb01("#fb6b1d");
    const naive = [(wr + ar) / 2, (wg + ag) / 2, (wb + ab) / 2];
    const luma = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(luma([r, g, b])).toBeGreaterThan(luma(naive));
  });

  it("takes the later of two stops sharing a position", () => {
    const stops = [
      { at: 0.5, color: "#ffffff" },
      { at: 0.5, color: "#2e222f" },
    ];
    const [r] = lut(stops, 1);
    expect(near(r, hexToRgb01("#2e222f")[0])).toBe(true);
  });

  it("indexes the table over the whole life and never past its end", () => {
    expect(rampIndexAt(0)).toBe(0);
    expect(rampIndexAt(1)).toBe(RAMP_LUT_SIZE - 1);
    expect(rampIndexAt(1.5)).toBe(RAMP_LUT_SIZE - 1);
    expect(rampIndexAt(-1)).toBe(0);
  });
});

describe("what validates", () => {
  it("refuses an inverted lifetime range", () => {
    const inverted = { ...DEFAULT_PARTICLES, ttlFromMs: 900, ttlToMs: 100 };
    expect(v.safeParse(particleEmitterSchema, inverted).success).toBe(false);
  });

  it("refuses a ramp with no stops", () => {
    expect(v.safeParse(particleEmitterSchema, { ...DEFAULT_PARTICLES, ramp: [] }).success).toBe(
      false,
    );
  });

  it("defaults a plume authored before the wind to still air", () => {
    const { windX: _x, windY: _y, ...stillAir } = DEFAULT_PARTICLES;
    const parsed = v.parse(particleEmitterSchema, stillAir);
    expect(parsed.windX).toBe(0);
    expect(parsed.windY).toBe(0);
  });

  it("defaults a plume to lighting itself", () => {
    const parsed = v.parse(particleEmitterSchema, {
      ...DEFAULT_PARTICLES,
      lit: undefined,
    });
    expect(parsed.lit).toBe(false);
  });
});

describe("a drawn shape", () => {
  const Z = ["#####", "...#.", "..#..", ".#...", "#####"];

  it("defaults a plume authored before shapes to a circle", () => {
    const { shape: _shape, ...circle } = DEFAULT_PARTICLES;
    expect(v.parse(particleEmitterSchema, circle).shape).toBeNull();
  });

  it("reads five rows of five", () => {
    expect(v.parse(particleEmitterSchema, { ...DEFAULT_PARTICLES, shape: Z }).shape).toEqual(Z);
  });

  it("refuses a shape of the wrong size or with other characters", () => {
    for (const shape of [Z.slice(1), [...Z.slice(1), "####"], [...Z.slice(1), "##x##"]]) {
      expect(v.safeParse(particleEmitterSchema, { ...DEFAULT_PARTICLES, shape }).success).toBe(
        false,
      );
    }
  });

  it("reads a pixel by column and row from the top", () => {
    expect(shapeHas(Z, 3, 1)).toBe(true);
    expect(shapeHas(Z, 1, 1)).toBe(false);
  });

  it("flips one pixel and leaves the rest", () => {
    const one = toggleShapePixel(EMPTY_SHAPE, 2, 0);
    expect(one).toEqual(["..#..", ".....", ".....", ".....", "....."]);
    expect(toggleShapePixel(one, 2, 0)).toEqual(EMPTY_SHAPE);
  });
});
