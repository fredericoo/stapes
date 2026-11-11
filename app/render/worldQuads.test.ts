import { describe, expect, it } from "vitest";
import { buildMergedQuadGeometry, windStepAt, WIND_STEP_MS, type Quad } from "./worldQuads";

function quad(over: Partial<Quad>): Quad {
  return {
    x: 0,
    y: 0,
    w: 16,
    h: 16,
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    box: { eastPx: 8, southPx: 8, foot: 0, top: 4 },
    stackBias: 0,
    lightX0: 0,
    lightY0: 0,
    lightX1: 1,
    lightY1: 1,
    unlit: false,
    ...over,
  };
}

describe("sway attributes", () => {
  it("measures a corner's row up from the vertices that carry the foot of the art", () => {
    const geo = buildMergedQuadGeometry([quad({ w: 16, h: 24, sway: { px: 2, rootPx: 6 } })]);
    const uv = geo.getAttribute("uv");
    const sway = geo.getAttribute("aSway");
    const bend = geo.getAttribute("aSwayBend");
    for (let v = 0; v < 4; v++) {
      const atFoot = uv.getY(v) === 0;
      const atLeft = uv.getX(v) === 0;
      expect([sway.getX(v), sway.getY(v), sway.getZ(v), sway.getW(v)]).toEqual([
        atLeft ? 0 : 16,
        atFoot ? 0 : 24,
        16,
        24,
      ]);
      expect([bend.getX(v), bend.getY(v)]).toEqual([2, 6]);
    }
  });

  it("leaves a quad that does not sway at zero, which the shader reads as still", () => {
    const geo = buildMergedQuadGeometry([quad({})]);
    expect(Array.from(geo.getAttribute("aSwayBend").array)).toEqual(new Array(8).fill(0));
  });
});

describe("windStepAt", () => {
  it("holds one step for a whole WIND_STEP_MS", () => {
    expect(windStepAt(WIND_STEP_MS - 1)).toBe(0);
    expect(windStepAt(WIND_STEP_MS)).toBe(1);
  });
});
