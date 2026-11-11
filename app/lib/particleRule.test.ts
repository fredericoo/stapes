import { describe, expect, it } from "vitest";
import { inHourSpan, ruleSelectsCell } from "./particleRule";

describe("inHourSpan", () => {
  it("runs a span whose start is after its end through midnight", () => {
    const night = { from: 20, to: 5 };
    expect(inHourSpan(night, 23 * 60)).toBe(true);
    expect(inHourSpan(night, 4 * 60 + 59)).toBe(true);
    expect(inHourSpan(night, 5 * 60)).toBe(false);
    expect(inHourSpan(night, 12 * 60)).toBe(false);
    expect(inHourSpan(night, 20 * 60)).toBe(true);
  });

  it("excludes the end hour of a daytime span", () => {
    const day = { from: 7, to: 18 };
    expect(inHourSpan(day, 7 * 60)).toBe(true);
    expect(inHourSpan(day, 18 * 60)).toBe(false);
  });
});

describe("ruleSelectsCell", () => {
  it("selects about one cell in oneIn, and the same cells every time it is asked", () => {
    const rule = { oneIn: 8 };
    const pick = () => {
      const cells: string[] = [];
      for (let x = 0; x < 64; x++) {
        for (let y = 0; y < 64; y++) {
          if (ruleSelectsCell(rule, x, y, 0)) cells.push(`${x},${y}`);
        }
      }
      return cells;
    };
    const first = pick();
    expect(pick()).toEqual(first);
    expect(first.length).toBeGreaterThan(64 * 8 * 0.7);
    expect(first.length).toBeLessThan(64 * 8 * 1.3);
  });

  it("selects every cell without a rule", () => {
    expect(ruleSelectsCell(undefined, 3, 4, 0)).toBe(true);
  });
});
