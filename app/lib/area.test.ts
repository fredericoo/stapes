import { describe, expect, it } from "vitest";
import { affectsBody, areaOffsets, inAreaShape } from "./area";

const RADIUS = 2;

describe("the cells a shape covers", () => {
  it("fills the whole box for a square", () => {
    expect(areaOffsets("square", RADIUS)).toHaveLength(25);
  });

  it("takes the two lines through the centre for a cross", () => {
    expect(areaOffsets("cross", RADIUS)).toHaveLength(9);
    expect(inAreaShape("cross", RADIUS, 2, 0)).toBe(true);
    expect(inAreaShape("cross", RADIUS, 1, 1)).toBe(false);
  });

  it("takes the two diagonals for a diagonal cross", () => {
    expect(areaOffsets("diagonal-cross", RADIUS)).toHaveLength(9);
    expect(inAreaShape("diagonal-cross", RADIUS, 2, -2)).toBe(true);
    expect(inAreaShape("diagonal-cross", RADIUS, 2, 0)).toBe(false);
  });

  it("rounds a circle off at the corners of its box and nowhere else", () => {
    expect(inAreaShape("circle", RADIUS, 2, 2)).toBe(false);
    expect(inAreaShape("circle", RADIUS, 2, 1)).toBe(true);
    expect(areaOffsets("circle", RADIUS)).toHaveLength(21);
  });

  it("never reaches past the radius along an axis", () => {
    for (const shape of ["circle", "square", "cross", "diagonal-cross"] as const) {
      expect(inAreaShape(shape, RADIUS, RADIUS + 1, 0)).toBe(false);
    }
  });
});

describe("who an area is for", () => {
  it("spares the caster when it is for others, and only them when it is for self", () => {
    expect(affectsBody("others", true)).toBe(false);
    expect(affectsBody("others", false)).toBe(true);
    expect(affectsBody("self", true)).toBe(true);
    expect(affectsBody("self", false)).toBe(false);
    expect(affectsBody("both", true)).toBe(true);
    expect(affectsBody("both", false)).toBe(true);
  });
});
