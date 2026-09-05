import { describe, expect, it } from "vitest";
import { parseNumberInput, roundToStep } from "./numberParse";

describe("parseNumberInput", () => {
  it("commits a number inside the range", () => {
    expect(parseNumberInput("7", { min: 1, max: 10 })).toEqual({
      ok: true,
      value: 7,
    });
  });

  it("refuses a blank box unless blank is an answer", () => {
    expect(parseNumberInput("", { min: 1 })).toEqual({
      ok: false,
      error: "Required",
    });
    expect(parseNumberInput("  ", { allowBlank: true })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("names the whole range when both ends are set", () => {
    expect(parseNumberInput("0", { min: 1, max: 86400 })).toEqual({
      ok: false,
      error: "1 to 86400",
    });
    expect(parseNumberInput("99999", { min: 1, max: 86400 })).toEqual({
      ok: false,
      error: "1 to 86400",
    });
  });

  it("names the one end that is set", () => {
    expect(parseNumberInput("-1", { min: 0 })).toEqual({
      ok: false,
      error: "At least 0",
    });
    expect(parseNumberInput("5", { max: 4 })).toEqual({
      ok: false,
      error: "At most 4",
    });
  });

  it("rounds to the step rather than complaining about it", () => {
    expect(parseNumberInput("2.3", { step: 1 })).toEqual({ ok: true, value: 2 });
    expect(parseNumberInput("0.3", { step: 0.1 })).toEqual({
      ok: true,
      value: 0.3,
    });
    expect(parseNumberInput("1.26", { step: 0.5 })).toEqual({
      ok: true,
      value: 1.5,
    });
  });

  it("refuses what Number cannot read", () => {
    expect(parseNumberInput("abc", {})).toEqual({
      ok: false,
      error: "Not a number",
    });
    expect(parseNumberInput("Infinity", {})).toEqual({
      ok: false,
      error: "Not a number",
    });
  });
});

describe("roundToStep", () => {
  it("lands on the decimal the author typed, not the binary neighbour", () => {
    expect(roundToStep(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundToStep(7, 10)).toBe(10);
  });
});
