import { describe, expect, it } from "vitest";
import {
  beats,
  EFFECTIVENESS_EDGE,
  ELEMENTS,
  type Element,
  effectiveness,
  NEUTRAL,
} from "./element";

/**
 * The wheel, on its own.
 *
 * Nothing here needs a body, a stone or a world — which is the point of the
 * module being this small. What a spell is worth against what it lands on is
 * arithmetic over two lists of words.
 */

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
    expect(effectiveness(["water"], ["fire"])).toBeCloseTo(
      EFFECTIVENESS_EDGE,
      6,
    );
    expect(effectiveness(["fire"], ["nature"])).toBeCloseTo(
      EFFECTIVENESS_EDGE,
      6,
    );
    expect(effectiveness(["nature"], ["water"])).toBeCloseTo(
      EFFECTIVENESS_EDGE,
      6,
    );
  });

  it("charges its exact reciprocal for the wrong side", () => {
    expect(effectiveness(["fire"], ["water"])).toBeCloseTo(RESISTED, 6);
    expect(effectiveness(["nature"], ["fire"])).toBeCloseTo(RESISTED, 6);
    expect(effectiveness(["water"], ["nature"])).toBeCloseTo(RESISTED, 6);
  });

  /**
   * The property the reciprocal exists for, and the reason a body attuned to
   * everything is a body attuned to nothing: every spell gains one edge and
   * loses one, and the two cancel exactly rather than nearly.
   */
  it("comes to exactly one against a body attuned to all three", () => {
    for (const element of ELEMENTS) {
      expect(effectiveness([element], ELEMENTS)).toBe(NEUTRAL);
    }
  });

  it("multiplies per element being defended", () => {
    // Fire beats the nature half and loses to the water half, so the two cancel.
    expect(effectiveness(["fire"], ["nature", "water"])).toBeCloseTo(
      NEUTRAL,
      6,
    );
    // Nothing on the wheel answers either half, so neither moves.
    expect(effectiveness(["fire"], ["fire", "fire"])).toBe(NEUTRAL);
  });

  /**
   * A spell made of two things picks whichever half wins, which is what stops
   * breadth from being a liability — see the module note on why the second test
   * is an `else`.
   */
  it("lets an advantage anywhere beat a disadvantage everywhere", () => {
    // Water beats the target's fire; the target's fire would beat nothing here.
    expect(effectiveness(["fire", "water"], ["fire"])).toBeCloseTo(
      EFFECTIVENESS_EDGE,
      6,
    );
    // Nature beats the target's water, even though the target's water beats the
    // fire the caster is also throwing.
    expect(effectiveness(["fire", "nature"], ["water"])).toBeCloseTo(
      EFFECTIVENESS_EDGE,
      6,
    );
  });

  it("never reads an element it was not given", () => {
    const attacking: Element[] = ["fire"];
    const defending: Element[] = ["nature"];
    effectiveness(attacking, defending);
    expect(attacking).toEqual(["fire"]);
    expect(defending).toEqual(["nature"]);
  });
});
