import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  compileRamp,
  DEFAULT_PARTICLES,
  particleEmitterSchema,
  RAMP_LUT_SIZE,
  rampIndexAt,
} from "./particleVfx";
import { hexToRgb01, srgbToOklab } from "./palette";

/**
 * What an authored plume comes to.
 *
 * A ramp is a *number* and can be pinned, which is the whole reason these
 * assertions look nothing like the tint's next door: there is a right answer to
 * "what colour is this particle at half its life", and it is worth writing down.
 */

const lut = (stops: { at: number; color: string }[], t: number) => {
  const compiled = compileRamp(stops);
  const base = rampIndexAt(t) * 3;
  return [compiled[base]!, compiled[base + 1]!, compiled[base + 2]!] as const;
};

const near = (a: number, b: number, tolerance = 0.02) =>
  Math.abs(a - b) <= tolerance;

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
    // A ramp is not obliged to start at 0 or finish at 1, and a particle born
    // before the first stop is not a particle with no colour.
    //
    // Asserted against the stop's own colour rather than against the table entry
    // at the stop's position, because those are not the same number: 64 samples
    // cannot land exactly on 0.25, so the nearest entry sits a hair *inside* the
    // ramp and has already begun interpolating. What is being tested is the
    // hold, and the hold is exact.
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
    // The whole argument for interpolating in OKLab. Halfway from white to a
    // mid amber is a warm cream; the naive sRGB midpoint is darker and duller,
    // and a fire made of those looks like a fire behind a dirty window.
    const stops = [
      { at: 0, color: "#ffffff" },
      { at: 1, color: "#fb6b1d" },
    ];
    const [r, g, b] = lut(stops, 0.5);
    const [wr, wg, wb] = hexToRgb01("#ffffff");
    const [ar, ag, ab] = hexToRgb01("#fb6b1d");
    const naive = [(wr + ar) / 2, (wg + ag) / 2, (wb + ab) / 2];
    const luma = (c: readonly number[]) =>
      0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
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
    // Life is clamped rather than wrapped: a particle read a hair past its own
    // death must not come back round to its birth colour.
    expect(rampIndexAt(1.5)).toBe(RAMP_LUT_SIZE - 1);
    expect(rampIndexAt(-1)).toBe(0);
  });
});

describe("what validates", () => {
  it("refuses an inverted lifetime range", () => {
    const inverted = { ...DEFAULT_PARTICLES, ttlFromMs: 900, ttlToMs: 100 };
    expect(
      v.safeParse(particleEmitterSchema, inverted).success,
    ).toBe(false);
  });

  it("refuses a ramp with no stops", () => {
    expect(
      v.safeParse(particleEmitterSchema, { ...DEFAULT_PARTICLES, ramp: [] })
        .success,
    ).toBe(false);
  });

  it("defaults a plume to lighting itself", () => {
    // Every emitter authored before `lit` existed glowed in the dark, and it has
    // to keep doing so — a silent change to how a fire reads at night would be
    // worse than an author having to tick a box.
    const parsed = v.parse(particleEmitterSchema, {
      ...DEFAULT_PARTICLES,
      lit: undefined,
    });
    expect(parsed.lit).toBe(false);
  });
});
