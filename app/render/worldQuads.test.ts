import { describe, expect, it } from "vitest";
import { depthBox } from "../lib/geometry";
import { buildSpreadQuadGeometry, writeBoxAttr } from "./worldQuads";

const SPRITE = {
  w: 8,
  h: 8,
  u0: 0,
  v0: 0,
  u1: 1,
  v1: 1,
  box: depthBox(2, 3, 0, 1),
  stackBias: 10,
  lightX0: 2,
  lightY0: 3,
  lightX1: 3,
  lightY1: 4,
  unlit: false,
};

function stackOfEachSprite(geo: ReturnType<typeof buildSpreadQuadGeometry>): number[] {
  const stacks = geo.getAttribute("aStack").array as Float32Array;
  return Array.from({ length: stacks.length / 4 }, (_, i) => stacks[i * 4]!);
}

describe("buildSpreadQuadGeometry", () => {
  it("keeps each sprite's depth nudge when a moving pile's box is rewritten", () => {
    const geo = buildSpreadQuadGeometry(SPRITE, [
      { dx: -3, dy: -3, stackNudge: 0.25 },
      { dx: 3, dy: 3, stackNudge: 0.5 },
    ]);
    expect(stackOfEachSprite(geo)).toEqual([10.25, 10.5]);

    writeBoxAttr(geo, depthBox(2, 4, 0, 1), 20);

    expect(stackOfEachSprite(geo)).toEqual([20.25, 20.5]);
    const boxes = geo.getAttribute("aBox").array as Float32Array;
    expect(boxes[boxes.length - 3]).toBe(depthBox(2, 4, 0, 1).southPx);
  });
});
