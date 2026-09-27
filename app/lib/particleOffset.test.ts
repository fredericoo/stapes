import { describe, expect, it } from "vitest";
import { type OffsetScope, parseOffsetFormula } from "./particleOffset";

const scope: OffsetScope = { AGE_SEC: 1.5, LIFE: 0.25, SEED: 0.75 };

function evaluate(source: string, over: Partial<OffsetScope> = {}): number | null {
  const formula = parseOffsetFormula(source);
  return formula ? formula({ ...scope, ...over }) : null;
}

describe("an offset formula", () => {
  it("keeps the fraction a status formula would round away", () => {
    expect(evaluate("1 / 4")).toBe(0.25);
    expect(evaluate("0 - 0.5")).toBe(-0.5);
  });

  it("reads the particle's age, life and seed", () => {
    expect(evaluate("AGE_SEC")).toBe(1.5);
    expect(evaluate("LIFE")).toBe(0.25);
    expect(evaluate("SEED")).toBe(0.75);
  });

  it("has what a circle and a spiral are written with", () => {
    expect(evaluate("cos(PI)")).toBeCloseTo(-1);
    expect(evaluate("sin(PI / 2)")).toBeCloseTo(1);
    expect(evaluate("sqrt(9)")).toBe(3);
    expect(evaluate("pow(2, 3)")).toBe(8);
    expect(evaluate("LIFE * cos(2 * PI * SEED)", { LIFE: 0.5, SEED: 0.5 })).toBeCloseTo(-0.5);
  });

  it("reads anything non-finite as no offset", () => {
    expect(evaluate("1 / 0")).toBe(0);
    expect(evaluate("sqrt(0 - 1)")).toBe(0);
  });

  it.each([
    ["MAX_HP", "a status variable"],
    ["has_status('burned')", "a status lookup"],
    ["cos(1, 2)", "a function given too many arguments"],
    ["t * 2", "a variable that does not exist"],
  ])("refuses %s (%s)", (source) => {
    expect(parseOffsetFormula(source)).toBeNull();
  });
});
