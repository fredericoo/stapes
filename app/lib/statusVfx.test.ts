import { describe, expect, it } from "vitest";
import { MAX_LIGHT_LEVEL } from "./lightingFlood";
import {
  applyTint,
  NO_VFX,
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

const near = (a: number, b: number, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

describe("a tint", () => {
  const purple: StatusTint = { color: "#a884f3", strength: 0.5, keepLuma: 1 };

  it("leaves a sprite alone at no strength", () => {
    const sprite = [0.8, 0.2, 0.2] as const;
    expect(applyTint(sprite, { ...purple, strength: 0 })).toEqual([0.8, 0.2, 0.2]);
  });

  it("keeps every shading step when the lightness is kept", () => {
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
    const window = 4_000;
    expect(taperAt(2_000, window)).toBe(taperAt(2_000, window));
    expect(taperAt(600_000, window)).toBe(1);
  });

  it("never tapers a status that did not ask to", () => {
    expect(taperAt(1, 0)).toBe(1);
    expect(taperAt(0, 0)).toBe(1);
  });

  it("lands on a bounded set of steps, so the caches stay bounded", () => {
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
    expect(taperedTint(tint, 1)).toBe(tint);
  });

  it("dims a cast light without changing its reach", () => {
    const light = { radius: 6, intensity: 0.8, color: "#fb6b1d" };
    const half = taperedGlow(light, 0.5);
    expect(half.intensity).toBeCloseTo(0.4);
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

  it("refuses a colour that is not a colour", () => {
    expect(
      v.safeParse(statusVfxSchema, {
        tint: { color: "purple", strength: 0.5 },
      }).success,
    ).toBe(false);
  });

  it("takes a cast light and holds it to the reach a light can have", () => {
    const ok = v.safeParse(statusVfxSchema, {
      light: { radius: 4, intensity: 0.6, color: "#fb6b1d" },
    });
    expect(ok.success).toBe(true);
    expect(
      v.safeParse(statusVfxSchema, {
        light: { radius: MAX_LIGHT_LEVEL + 1, intensity: 1, color: "#ffffff" },
      }).success,
    ).toBe(false);
  });

  it("defaults a tint to keeping the sprite's own lightness", () => {
    const parsed = v.parse(statusVfxSchema, {
      tint: { color: "#a884f3", strength: 0.4 },
    });
    expect(parsed.tint?.keepLuma).toBe(1);
  });
});
