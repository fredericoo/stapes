import { describe, expect, it } from "vitest";
import { AREA_SHAPES, affectsBody, areaOffsets, inAreaShape, MAX_AREA_RADIUS } from "./area";

const RADIUS = 2;

const CARDINAL_STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function escapesRing(radius: number): boolean {
  const seen = new Set(["0,0"]);
  const queue: [number, number][] = [[0, 0]];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [x, y] = next;
    if (Math.abs(x) > radius || Math.abs(y) > radius) return true;
    for (const [dx, dy] of CARDINAL_STEPS) {
      const key = `${x + dx},${y + dy}`;
      if (seen.has(key) || inAreaShape("ring", radius, x + dx, y + dy)) continue;
      seen.add(key);
      queue.push([x + dx, y + dy]);
    }
  }
  return false;
}

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

  it("takes the rim of the circle for a ring, leaving its middle open", () => {
    expect(inAreaShape("ring", RADIUS, 0, 0)).toBe(false);
    expect(inAreaShape("ring", RADIUS, 1, 1)).toBe(false);
    expect(inAreaShape("ring", RADIUS, 2, 1)).toBe(true);
    expect(areaOffsets("ring", RADIUS)).toHaveLength(
      areaOffsets("circle", RADIUS).length - areaOffsets("circle", RADIUS - 1).length,
    );
  });

  it("closes a ring of every radius against walking out of it", () => {
    for (let radius = 1; radius <= MAX_AREA_RADIUS; radius++) {
      expect(escapesRing(radius)).toBe(false);
    }
  });

  it("never reaches past the radius along an axis", () => {
    for (const shape of AREA_SHAPES) {
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
