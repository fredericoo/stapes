import { describe, expect, it } from "vitest";
import {
  absoluteElevation,
  drawOrder,
  tileDepth,
} from "./geometry";
import { HEIGHT_PER_LEVEL } from "./types";

describe("absoluteElevation", () => {
  it("combines level floor with in-stack elevation", () => {
    expect(absoluteElevation(0, 0)).toBe(0);
    expect(absoluteElevation(0, 4)).toBe(4);
    expect(absoluteElevation(1, 0)).toBe(HEIGHT_PER_LEVEL);
    expect(absoluteElevation(1, 2)).toBe(HEIGHT_PER_LEVEL + 2);
  });
});

describe("drawOrder / tileDepth across levels", () => {
  it("lets east win over a taller western tile on the same row", () => {
    const westTall = drawOrder(5, 10, absoluteElevation(0, 5), 2);
    const eastRoof = drawOrder(6, 10, absoluteElevation(1, 0), 0);
    expect(eastRoof).toBeGreaterThan(westTall);
    expect(tileDepth(6, 10, absoluteElevation(1, 0), 0)).toBeGreaterThan(
      tileDepth(5, 10, absoluteElevation(0, 5), 2),
    );
  });

  it("lets south win over a northern tile on a superior level", () => {
    // Level banding used to bury this; grid position must outrank level.
    const south = drawOrder(5, 10, absoluteElevation(0, 5), 2);
    const northRoof = drawOrder(5, 9, absoluteElevation(1, 0), 0);
    expect(south).toBeGreaterThan(northRoof);
    expect(tileDepth(5, 10, absoluteElevation(0, 5), 2)).toBeGreaterThan(
      tileDepth(5, 9, absoluteElevation(1, 0), 0),
    );
  });

  it("keeps southern tiles in front at equal elevation", () => {
    const north = drawOrder(5, 9, absoluteElevation(0, 0), 0);
    const south = drawOrder(5, 10, absoluteElevation(0, 0), 0);
    expect(south).toBeGreaterThan(north);
    expect(tileDepth(5, 10, 0, 0)).toBeGreaterThan(tileDepth(5, 9, 0, 0));
  });

  it("orders same-cell stacks by absolute elevation across levels", () => {
    const lower = drawOrder(3, 3, absoluteElevation(0, 2), 0);
    const upper = drawOrder(3, 3, absoluteElevation(1, 0), 0);
    expect(upper).toBeGreaterThan(lower);
    expect(tileDepth(3, 3, absoluteElevation(1, 0), 0)).toBeGreaterThan(
      tileDepth(3, 3, absoluteElevation(0, 2), 0),
    );
  });

  it("matches z*4+elev at equal foot height and stack index", () => {
    const lower = drawOrder(3, 3, absoluteElevation(0, 4), 0);
    const upper = drawOrder(3, 3, absoluteElevation(1, 0), 0);
    expect(lower).toBe(upper);
    expect(tileDepth(3, 3, absoluteElevation(0, 4), 0)).toBe(
      tileDepth(3, 3, absoluteElevation(1, 0), 0),
    );
  });

  it("puts later same-cell stack entries clearly in front of height-0 ground", () => {
    // (0,0): dirt h=0 then player — shared absElev, stackIndex must beat depth precision.
    const dirt = tileDepth(0, 0, 0, 0);
    const player = tileDepth(0, 0, 0, 1);
    expect(player).toBeGreaterThan(dirt);
    expect(player - dirt).toBeGreaterThan(0.00005);
  });

  it("tileDepth stays within the ortho frustum budget", () => {
    const d = tileDepth(40, 40, absoluteElevation(8, 8), 16);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(40);
  });
});
