import { describe, expect, it } from "vitest";
import { classFor, textFor, type DamageNumberView } from "./damageNumbers";

/**
 * What a swing says, and what colour it says it in.
 *
 * Three outcomes and four readings, because a blow that lands for nothing is
 * not the same event as a blow that never landed — and a bare `0` says neither.
 */

const swing = (over: Partial<DamageNumberView>): DamageNumberView => ({
  id: "hit-1",
  x: 0,
  y: 0,
  outcome: "hit",
  amount: 3,
  own: false,
  elapsedMs: 0,
  ...over,
});

describe("what a number says", () => {
  it("says the figure for a blow that took hit points", () => {
    expect(textFor(swing({ amount: 3 }))).toBe("3");
  });

  /**
   * A bare `0` looks like a number that failed to render, and it is one glyph
   * away from every other figure in the layer. "blocked" also says *why*, which
   * is a different fact from having swung at air.
   */
  it("says blocked for a blow that landed and did nothing", () => {
    expect(textFor(swing({ amount: 0 }))).toBe("blocked");
  });

  it("keeps a miss and a dodge tellable apart", () => {
    expect(textFor(swing({ outcome: "miss", amount: 0 }))).toBe("miss");
  });
});

describe("what colour it says it in", () => {
  it("marks a blow the viewer took, and only if it took something", () => {
    expect(classFor(swing({ amount: 3, own: true }))).toContain("damage-number--own");
    expect(classFor(swing({ amount: 3, own: false }))).not.toContain("--own");
  });

  /**
   * Red marks hit points you cannot afford to miss while reading the traffic. A
   * blocked blow took none, so it belongs with the misses whoever it happened to.
   */
  it("reads a blocked blow as nothing, whoever it happened to", () => {
    expect(classFor(swing({ amount: 0, own: true }))).toContain("--nothing");
    expect(classFor(swing({ amount: 0, own: false }))).toContain("--nothing");
  });

  it("reads a miss and a dodge as nothing too", () => {
    expect(classFor(swing({ outcome: "miss", own: true }))).toContain("--nothing");
  });
});
