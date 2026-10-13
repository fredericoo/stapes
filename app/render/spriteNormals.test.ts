import { describe, expect, it } from "vitest";
import { BAKED_LIGHT, normalize, normalShade, UP, type Vec3 } from "./spriteNormals";

const EAST_FACE: Vec3 = [1, 0, 0];
const WEST_FACE: Vec3 = [-1, 0, 0];
const FROM_EAST = normalize([1, 0, 0.8]);
const OVERHEAD: Vec3 = [0, 0, 1];

describe("normalShade", () => {
  it("leaves open ground as painted under any light", () => {
    for (const light of [FROM_EAST, OVERHEAD, BAKED_LIGHT]) {
      expect(normalShade(UP, light)).toBeCloseTo(1);
    }
  });

  it("leaves every surface as painted under the light it was painted in", () => {
    for (const n of [EAST_FACE, WEST_FACE, normalize([0.3, -0.6, 0.7])]) {
      expect(normalShade(n, BAKED_LIGHT)).toBeCloseTo(1);
    }
  });

  it("brightens the side facing a light and not the side turned from it", () => {
    expect(normalShade(EAST_FACE, FROM_EAST)).toBeGreaterThan(1);
    expect(normalShade(WEST_FACE, FROM_EAST)).toBeLessThanOrEqual(1);
  });
});
