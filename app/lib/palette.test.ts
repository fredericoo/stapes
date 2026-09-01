import { describe, expect, it } from "vitest";
import {
  STAPES_PALETTE,
  hexToRgb01,
  meanPaletteSpacing,
  nearestPaletteIndex,
  oklabToSrgb,
  paletteOklab,
  paletteRgb01,
  srgbToOklab,
} from "./palette";

const lab = paletteOklab(STAPES_PALETTE);
const rgb = paletteRgb01(STAPES_PALETTE);

describe("OKLab round-trip", () => {
  it("survives round-trip for every palette entry", () => {
    for (const hex of STAPES_PALETTE) {
      const [r, g, b] = hexToRgb01(hex);
      const [L, a, bb] = srgbToOklab(r, g, b);
      const [rr, gg, br] = oklabToSrgb(L, a, bb);
      expect(rr).toBeCloseTo(r, 4);
      expect(gg).toBeCloseTo(g, 4);
      expect(br).toBeCloseTo(b, 4);
    }
  });
});

describe("nearestPaletteIndex", () => {
  it("returns identity for each palette colour itself", () => {
    for (let i = 0; i < STAPES_PALETTE.length; i++) {
      const entry: [number, number, number] = [
        lab[i * 3]!,
        lab[i * 3 + 1]!,
        lab[i * 3 + 2]!,
      ];
      expect(nearestPaletteIndex(entry, lab, 1)).toBe(i);
    }
  });
});

describe("meanPaletteSpacing", () => {
  it("is finite and positive", () => {
    const spacing = meanPaletteSpacing(lab);
    expect(Number.isFinite(spacing)).toBe(true);
    expect(spacing).toBeGreaterThan(0);
  });

  it("rgb helper length matches palette", () => {
    expect(rgb.length).toBe(STAPES_PALETTE.length * 3);
    expect(lab.length).toBe(STAPES_PALETTE.length * 3);
  });
});
