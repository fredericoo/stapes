import { describe, expect, it } from "vitest";
import { castLineClass, castLineDots, castLinePhase } from "./castLines";

describe("castLineClass", () => {
  it("draws a cast at the viewer in red", () => {
    expect(castLineClass({ atYou: true })).toBe("cast-line cast-line--at-you");
  });

  it("draws a cast at anybody else in white", () => {
    expect(castLineClass({ atYou: false })).toBe("cast-line");
  });

  it("draws the viewer's attack at half strength", () => {
    expect(castLineClass({ atYou: false, attack: true })).toBe("cast-line cast-line--attack");
  });
});

describe("castLineDots", () => {
  it("puts a dot on every third whole pixel of a straight line", () => {
    expect(castLineDots({ x: 2.6, y: 5.9 }, { x: 9.2, y: 5.1 }, 0)).toEqual([
      { x: 2, y: 5 },
      { x: 5, y: 5 },
      { x: 8, y: 5 },
    ]);
  });

  it("steps a diagonal along its longer axis, one dot per pixel walked", () => {
    expect(castLineDots({ x: 0, y: 0 }, { x: -6, y: 3 }, 0)).toEqual([
      { x: 0, y: 0 },
      { x: -3, y: 2 },
      { x: -6, y: 3 },
    ]);
  });

  it("moves every dot one pixel towards the target per phase", () => {
    expect(castLineDots({ x: 0, y: 0 }, { x: 0, y: 7 }, 1)).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 4 },
      { x: 0, y: 7 },
    ]);
  });

  it("draws one dot when both ends share a pixel", () => {
    expect(castLineDots({ x: 4.2, y: 4.8 }, { x: 4.9, y: 4.1 }, 0)).toEqual([{ x: 4, y: 4 }]);
  });
});

describe("castLinePhase", () => {
  it("advances one pixel every 100ms and repeats after three", () => {
    expect([0, 99, 100, 250, 300].map(castLinePhase)).toEqual([0, 0, 1, 2, 0]);
  });
});
