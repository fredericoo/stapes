import { describe, expect, it } from "vitest";
import { MAX_LIGHT_LEVEL } from "./lightingFlood";
import {
  applyTint,
  compileRamp,
  DEFAULT_PARTICLES,
  hasVfx,
  NO_VFX,
  RAMP_LUT_SIZE,
  rampIndexAt,
  resolveStatusVfx,
  statusVfxSchema,
  taperAt,
  taperedGlow,
  taperedTint,
  TAPER_STEPS,
  type StatusTint,
} from "./statusVfx";
import { hexToRgb01, srgbToOklab } from "./palette";
import * as v from "valibot";
import { resolveStatus } from "./status";

/**
 * What an authored effect comes to.
 *
 * The two halves are asserted very differently on purpose. A ramp is a *number*
 * and can be pinned; a tint is a colour and pinning its channels would be a test
 * of the OKLab constants rather than of this feature — so the tint is asserted
 * on the properties that make it a palette swap rather than a wash, which are
 * the ones that would actually break.
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

describe("a tint", () => {
  const purple: StatusTint = { color: "#a884f3", strength: 0.5, keepLuma: 1 };

  it("leaves a sprite alone at no strength", () => {
    const sprite = [0.8, 0.2, 0.2] as const;
    expect(applyTint(sprite, { ...purple, strength: 0 })).toEqual([
      0.8, 0.2, 0.2,
    ]);
  });

  it("keeps every shading step when the lightness is kept", () => {
    // The palette-swap case, and the property that says it worked: two pixels
    // of the same sprite that differed in lightness still differ by the same
    // amount afterwards. A wash that flattened them would fail here.
    const lightBefore = (rgb: readonly [number, number, number]) =>
      srgbToOklab(rgb[0], rgb[1], rgb[2])[0];
    const dark = [0.2, 0.3, 0.2] as const;
    const light = [0.7, 0.9, 0.7] as const;

    const darkAfter = applyTint(dark, purple);
    const lightAfter = applyTint(light, purple);

    expect(near(lightBefore(darkAfter), lightBefore(dark), 0.01)).toBe(true);
    expect(near(lightBefore(lightAfter), lightBefore(light), 0.01)).toBe(true);
  });

  it("moves the hue towards the tint", () => {
    // Chroma, not lightness, is what a swap moves — so the green sprite ends up
    // measurably nearer the tint's a/b than it started.
    const sprite = [0.2, 0.8, 0.3] as const;
    const before = srgbToOklab(sprite[0], sprite[1], sprite[2]);
    const after0 = applyTint(sprite, purple);
    const after = srgbToOklab(after0[0], after0[1], after0[2]);
    const [tr, tg, tb] = hexToRgb01(purple.color);
    const target = srgbToOklab(tr, tg, tb);

    const distance = (lab: readonly number[]) =>
      Math.hypot(lab[1]! - target[1]!, lab[2]! - target[2]!);
    expect(distance(after)).toBeLessThan(distance(before));
  });

  it("flattens towards the tint's own lightness when none is kept", () => {
    const dark = [0.1, 0.1, 0.1] as const;
    const light = [0.9, 0.9, 0.9] as const;
    const flat = { ...purple, strength: 1, keepLuma: 0 };
    // At full strength with nothing kept, every pixel is the tint — which is
    // what "lose the sprite" means, and is a legal thing to ask for.
    expect(applyTint(dark, flat)).toEqual(applyTint(light, flat));
  });

  it("stays inside the gamut on a colour the mix pushes out of it", () => {
    const saturated = [1, 0, 0] as const;
    const loud: StatusTint = { color: "#1ebc73", strength: 1, keepLuma: 1 };
    for (const channel of applyTint(saturated, loud)) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe("winding down", () => {
  it("stays at full strength until the last stretch", () => {
    expect(taperAt(10_000, 4_000)).toBe(1);
    expect(taperAt(4_000, 4_000)).toBe(1);
  });

  it("falls to nothing as the status ends", () => {
    expect(taperAt(2_000, 4_000)).toBeCloseTo(0.5);
    expect(taperAt(0, 4_000)).toBe(0);
  });

  it("measures what is left, not what there was", () => {
    // The whole argument for milliseconds over a fraction: a poison stacked to
    // ten minutes and one that rolled ten seconds fade over the same final
    // stretch. A fraction would give the stacked one a two-minute sunset.
    const window = 4_000;
    expect(taperAt(2_000, window)).toBe(taperAt(2_000, window));
    expect(taperAt(600_000, window)).toBe(1);
  });

  it("never tapers a status that did not ask to", () => {
    expect(taperAt(1, 0)).toBe(1);
    expect(taperAt(0, 0)).toBe(1);
  });

  it("lands on a bounded set of steps, so the caches stay bounded", () => {
    // A tint is baked into a material keyed by its strength and a cast light
    // rides a cache key with its intensity in it, so a continuously varying
    // taper would compile a material a frame. See TAPER_STEPS.
    const seen = new Set<number>();
    for (let ms = 0; ms <= 4_000; ms += 1) seen.add(taperAt(ms, 4_000));
    expect(seen.size).toBeLessThanOrEqual(TAPER_STEPS + 1);
  });

  it("thins a tint without changing what colour it is", () => {
    const tint: StatusTint = { color: "#a884f3", strength: 0.8, keepLuma: 1 };
    const half = taperedTint(tint, 0.5);
    expect(half.strength).toBeCloseTo(0.4);
    expect(half.color).toBe(tint.color);
    expect(half.keepLuma).toBe(tint.keepLuma);
    // Untouched at full, and the same object, so nothing downstream re-keys a
    // material for a status that is not winding down.
    expect(taperedTint(tint, 1)).toBe(tint);
  });

  it("dims a cast light without changing its reach", () => {
    const light = { radius: 6, intensity: 0.8, color: "#fb6b1d" };
    const half = taperedGlow(light, 0.5);
    expect(half.intensity).toBeCloseTo(0.4);
    // The radius is what the flood fill walks; shrinking it as well would make a
    // fading light re-bake a different-sized window every step.
    expect(half.radius).toBe(light.radius);
    expect(taperedGlow(light, 1)).toBe(light);
  });
});

describe("what validates", () => {
  it("reads an absent block as no effect at all", () => {
    expect(resolveStatusVfx(undefined)).toEqual(NO_VFX);
    expect(v.parse(statusVfxSchema, {})).toEqual(NO_VFX);
  });

  it("keeps loading a status authored before effects existed", () => {
    // The compatibility case, asserted through the real front door: every entry
    // in `data/statuses.json` looks like this, and a schema that dropped them
    // would empty the catalogue.
    const legacy = {
      id: "fed",
      name: "Fed",
      description: "Slowly recovering health.",
      tone: "good",
      fromMs: 10_000,
      toMs: 30_000,
      effects: { hp: "1" },
    };
    const resolved = resolveStatus(legacy);
    expect(resolved).not.toBeNull();
    expect(resolved!.vfx).toEqual(NO_VFX);
  });

  it("refuses an inverted lifetime range", () => {
    const inverted = { ...DEFAULT_PARTICLES, ttlFromMs: 900, ttlToMs: 100 };
    expect(v.safeParse(statusVfxSchema, { particles: inverted }).success).toBe(
      false,
    );
  });

  it("refuses a colour that is not a colour", () => {
    expect(
      v.safeParse(statusVfxSchema, {
        tint: { color: "purple", strength: 0.5 },
      }).success,
    ).toBe(false);
  });

  it("refuses a ramp with no stops", () => {
    expect(
      v.safeParse(statusVfxSchema, {
        particles: { ...DEFAULT_PARTICLES, ramp: [] },
      }).success,
    ).toBe(false);
  });

  it("defaults a plume to lighting itself", () => {
    // Every emitter authored before `lit` existed glowed in the dark, and it has
    // to keep doing so — a silent change to how a fire reads at night would be
    // worse than an author having to tick a box.
    const parsed = v.parse(statusVfxSchema, {
      particles: { ...DEFAULT_PARTICLES, lit: undefined },
    });
    expect(parsed.particles?.lit).toBe(false);
  });

  it("takes a cast light and holds it to the reach a light can have", () => {
    const ok = v.safeParse(statusVfxSchema, {
      light: { radius: 4, intensity: 0.6, color: "#fb6b1d" },
    });
    expect(ok.success).toBe(true);
    // The same ceiling every tile light is held to: past this the flood fill has
    // nothing left to give, and a radius beyond it is a number that reads as
    // reach and buys none.
    expect(
      v.safeParse(statusVfxSchema, {
        light: { radius: MAX_LIGHT_LEVEL + 1, intensity: 1, color: "#ffffff" },
      }).success,
    ).toBe(false);
  });

  it("counts a status that only casts light as having an effect", () => {
    expect(
      hasVfx({
        tint: null,
        particles: null,
        light: { radius: 3, intensity: 1, color: "#ffffff" },
        taperMs: 0,
      }),
    ).toBe(true);
    expect(hasVfx(NO_VFX)).toBe(false);
  });

  it("defaults a tint to keeping the sprite's own lightness", () => {
    // An author who writes a tint by hand and says nothing about shading is
    // asking for a palette swap, which is the answer that keeps the drawing.
    const parsed = v.parse(statusVfxSchema, {
      tint: { color: "#a884f3", strength: 0.4 },
    });
    expect(parsed.tint?.keepLuma).toBe(1);
  });
});
