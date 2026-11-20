import { describe, expect, it } from "vitest";
import { depthBox } from "../lib/geometry";
import {
  buildMergedQuadGeometry,
  buildSpreadQuadGeometry,
  concatQuadGeometries,
  writeBoxAttr,
} from "./worldQuads";

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

describe("concatQuadGeometries", () => {
  it("draws the same quads as one batch built from all of them", () => {
    const quads = Array.from({ length: 5 }, (_, i) => ({
      ...SPRITE,
      x: i * 8,
      y: i * 3,
      box: depthBox(i, 3, 0, 1),
      stackBias: i,
      unlit: i % 2 === 0,
    }));
    const whole = buildMergedQuadGeometry(quads);
    const joined = concatQuadGeometries([
      buildMergedQuadGeometry(quads.slice(0, 2)),
      buildMergedQuadGeometry(quads.slice(2)),
    ]);

    expect(Object.keys(joined.attributes).sort()).toEqual(Object.keys(whole.attributes).sort());
    for (const name of Object.keys(whole.attributes)) {
      expect(Array.from(joined.getAttribute(name).array), name).toEqual(
        Array.from(whole.getAttribute(name).array),
      );
    }
    expect(Array.from(joined.index!.array)).toEqual(Array.from(whole.index!.array));
  });
});
