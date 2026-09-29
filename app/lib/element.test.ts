import { describe, expect, it } from "vitest";
import {
  beats,
  EFFECTIVENESS_EDGE,
  ELEMENTS,
  type Element,
  effectiveness,
  NEUTRAL,
} from "./element";

describe("the wheel", () => {
  it("has every element beating exactly one and losing to exactly one", () => {
    for (const element of ELEMENTS) {
      expect(ELEMENTS.filter((other) => beats(element, other))).toHaveLength(1);
      expect(ELEMENTS.filter((other) => beats(other, element))).toHaveLength(1);
    }
  });

  it("never lets an element beat itself", () => {
    for (const element of ELEMENTS) expect(beats(element, element)).toBe(false);
  });

  it("runs the way the design says it does", () => {
    expect(beats("water", "fire")).toBe(true);
    expect(beats("fire", "nature")).toBe(true);
    expect(beats("nature", "water")).toBe(true);
  });
});

describe("effectiveness", () => {
  const RESISTED = 1 / EFFECTIVENESS_EDGE;

  it("is neutral when either side is made of nothing", () => {
    expect(effectiveness([], ["fire"])).toBe(NEUTRAL);
    expect(effectiveness(["water"], [])).toBe(NEUTRAL);
    expect(effectiveness([], [])).toBe(NEUTRAL);
  });

  it("is neutral in a mirror", () => {
    for (const element of ELEMENTS) {
      expect(effectiveness([element], [element])).toBe(NEUTRAL);
    }
  });

  it("pays an edge for the right side of the wheel", () => {
    expect(effectiveness(["water"], ["fire"])).toBeCloseTo(EFFECTIVENESS_EDGE, 6);
    expect(effectiveness(["fire"], ["nature"])).toBeCloseTo(EFFECTIVENESS_EDGE, 6);
    expect(effectiveness(["nature"], ["water"])).toBeCloseTo(EFFECTIVENESS_EDGE, 6);
  });

  it("charges its exact reciprocal for the wrong side", () => {
    expect(effectiveness(["fire"], ["water"])).toBeCloseTo(RESISTED, 6);
    expect(effectiveness(["nature"], ["fire"])).toBeCloseTo(RESISTED, 6);
    expect(effectiveness(["water"], ["nature"])).toBeCloseTo(RESISTED, 6);
  });

  it("comes to exactly one against a body attuned to all three", () => {
    for (const element of ELEMENTS) {
      expect(effectiveness([element], ELEMENTS)).toBe(NEUTRAL);
    }
  });

  it("multiplies per element being defended", () => {
    expect(effectiveness(["fire"], ["nature", "water"])).toBeCloseTo(NEUTRAL, 6);
    expect(effectiveness(["fire"], ["fire", "fire"])).toBe(NEUTRAL);
  });

  it("lets an advantage anywhere beat a disadvantage everywhere", () => {
    expect(effectiveness(["fire", "water"], ["fire"])).toBeCloseTo(EFFECTIVENESS_EDGE, 6);
    expect(effectiveness(["fire", "nature"], ["water"])).toBeCloseTo(EFFECTIVENESS_EDGE, 6);
  });

  it("never reads an element it was not given", () => {
    const attacking: Element[] = ["fire"];
    const defending: Element[] = ["nature"];
    effectiveness(attacking, defending);
    expect(attacking).toEqual(["fire"]);
    expect(defending).toEqual(["nature"]);
  });
});
