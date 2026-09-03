import { describe, expect, it } from "vitest";
import { type FormulaScope, integerise, parseFormula } from "./formula";

const scope: FormulaScope = {
  DURATION_SEC: 30,
  REMAINING_SEC: 12,
  ELAPSED_SEC: 18,
  MAX_HP: 16,
  HP: 9,
};

/** Compile and run in one go; the tests are about answers, not about handles. */
function evaluate(
  source: string,
  over: Partial<FormulaScope> = {},
): number | null {
  const formula = parseFormula(source);
  return formula ? formula.evaluate({ ...scope, ...over }) : null;
}

describe("parseFormula", () => {
  it("reads the variables", () => {
    expect(evaluate("MAX_HP")).toBe(16);
    expect(evaluate("REMAINING_SEC")).toBe(12);
    expect(evaluate("ELAPSED_SEC")).toBe(18);
  });

  it("gives multiplication precedence over addition", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
  });

  /** Left-associative, which only shows on the non-commutative operators. */
  it("associates to the left", () => {
    expect(evaluate("10 - 3 - 2")).toBe(5);
    expect(evaluate("100 / 5 / 2")).toBe(10);
  });

  it("takes a unary minus, including in front of a variable", () => {
    expect(evaluate("-3")).toBe(-3);
    expect(evaluate("-MAX_HP")).toBe(-16);
    expect(evaluate("10 - -3")).toBe(13);
  });

  it("runs the functions", () => {
    expect(evaluate("ceil(MAX_HP / 100)")).toBe(1);
    expect(evaluate("floor(MAX_HP / 100)")).toBe(0);
    expect(evaluate("abs(0 - 7)")).toBe(7);
    expect(evaluate("min(3, 9)")).toBe(3);
    expect(evaluate("max(3, 9)")).toBe(9);
  });

  /** The motivating example from the design, spelled out. */
  it("computes a heal that grows as a status runs down", () => {
    expect(evaluate("HP + REMAINING_SEC / 10")).toBe(10);
  });

  /**
   * Poison as authored: five at ten minutes left, one as it runs out, and the
   * four steps between are even two-minute bands of remaining time.
   */
  it("computes a poison that bites harder the longer it has left", () => {
    const source = "0 - min(5, max(1, ceil(REMAINING_SEC * 5 / 600)))";
    expect(evaluate(source, { REMAINING_SEC: 600 })).toBe(-5);
    expect(evaluate(source, { REMAINING_SEC: 481 })).toBe(-5);
    expect(evaluate(source, { REMAINING_SEC: 480 })).toBe(-4);
    expect(evaluate(source, { REMAINING_SEC: 120 })).toBe(-1);
    expect(evaluate(source, { REMAINING_SEC: 0 })).toBe(-1);
  });
});

describe("integerising", () => {
  /**
   * The one place `Math.round` is wrong: it rounds half *up*, so `-0.5` becomes
   * `-0` while `0.5` becomes `1`. A poison would be a shade weaker than the
   * matching heal for no reason anybody could read off the formula.
   */
  it("rounds half away from zero in both directions", () => {
    expect(integerise(0.5)).toBe(1);
    expect(integerise(-0.5)).toBe(-1);
    expect(integerise(2.5)).toBe(3);
    expect(integerise(-2.5)).toBe(-3);
  });

  it("reads anything non-finite as nothing happening", () => {
    expect(evaluate("1 / 0")).toBe(0);
    expect(integerise(Number.NaN)).toBe(0);
    expect(integerise(-Infinity)).toBe(0);
  });
});

describe("refusing a source that is not a formula", () => {
  it.each([
    ["", "empty"],
    ["   ", "only spaces"],
    ["1 +", "a dangling operator"],
    ["(1 + 2", "an unclosed bracket"],
    ["1 2", "two expressions with nothing between them"],
    ["MAX_HP; drop()", "a statement separator"],
    ["MAXHP", "a variable that does not exist"],
    ["sqrt(4)", "a function that does not exist"],
    ["min(3)", "a function given too few arguments"],
    ["max(1, 2, 3)", "a function given too many"],
    ["1.2.3", "a malformed number"],
    ["MAX_HP & 1", "an operator the language does not have"],
  ])("refuses %s (%s)", (source) => {
    expect(parseFormula(source)).toBeNull();
  });

  /**
   * The refusal has to be a null rather than a throw, because it is read where a
   * malformed block means "this tile does not do that" — see `./status`.
   */
  it("never throws on rubbish", () => {
    expect(() => parseFormula("(((((")).not.toThrow();
    expect(() => parseFormula("💥")).not.toThrow();
  });
});
