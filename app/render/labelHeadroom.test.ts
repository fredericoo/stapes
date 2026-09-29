import { describe, expect, it } from "vitest";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { labelHeadroomPx } from "./labelHeadroom";

describe("labelHeadroomPx", () => {
  it("still leaves a gap on a tile as tall as its cell", () => {
    expect(labelHeadroomPx(HEIGHT_PER_LEVEL)).toBe(1);
  });

  it("lifts a half-height tile clear of the art above its head", () => {
    const half = HEIGHT_PER_LEVEL / 2;
    expect(labelHeadroomPx(half)).toBe(1 + half * PX_PER_HEIGHT);
  });

  it("lifts a flat tile by a whole level's worth", () => {
    expect(labelHeadroomPx(0)).toBe(1 + HEIGHT_PER_LEVEL * PX_PER_HEIGHT);
  });

  it("never pulls a label down into a tile taller than a level", () => {
    for (const height of [HEIGHT_PER_LEVEL + 1, HEIGHT_PER_LEVEL * 4]) {
      expect(labelHeadroomPx(height)).toBe(1);
    }
  });

  it("never gives a taller tile more room than a shorter one", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let height = 0; height <= HEIGHT_PER_LEVEL * 3; height++) {
      const headroom = labelHeadroomPx(height);
      expect(headroom).toBeLessThanOrEqual(previous);
      previous = headroom;
    }
  });
});
