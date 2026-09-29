import { describe, expect, it } from "vitest";
import { classFor, textFor, type DamageNumberView } from "./damageNumbers";

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

  it("reads a blocked blow as nothing, whoever it happened to", () => {
    expect(classFor(swing({ amount: 0, own: true }))).toContain("--nothing");
    expect(classFor(swing({ amount: 0, own: false }))).toContain("--nothing");
  });

  it("reads a miss and a dodge as nothing too", () => {
    expect(classFor(swing({ outcome: "miss", own: true }))).toContain("--nothing");
  });
});

describe("a mend", () => {
  const mend = (amount: number, own = false): DamageNumberView =>
    swing({ outcome: "heal", amount, own });

  it("says which way the bar went, whatever the colour renders as", () => {
    expect(textFor(mend(5))).toBe("+5");
    expect(textFor(mend(1))).toBe("+1");
  });

  it("is the same green for the viewer and for everybody else", () => {
    expect(classFor(mend(5, true))).toBe(classFor(mend(5, false)));
    expect(classFor(mend(5))).toContain("damage-number--mend");
  });

  it("is never the word a blow of nothing gets", () => {
    expect(classFor(mend(5))).not.toContain("damage-number--nothing");
  });
});
