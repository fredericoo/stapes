import { describe, expect, it } from "vitest";
import { classFor, textFor, type DamageNumberView } from "./damageNumbers";

/**
 * What a swing says, and what colour it says it in.
 *
 * Three outcomes and five readings, because a blow that lands for nothing is
 * not the same event as a blow that never landed — and a bare `0` says neither.
 * A mend is the third outcome and the one that is not a swing at all: it reads
 * as a signed figure in green, because it is the only thing in this layer that
 * moves a health bar the other way.
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

describe("a mend", () => {
  const mend = (amount: number, own = false): DamageNumberView =>
    swing({ outcome: "heal", amount, own });

  /**
   * **Signed, and the sign is not decoration.** The green is doing real work —
   * it is what makes a heal readable at a glance in a column of red and white —
   * but a viewer who cannot separate those hues sees a bare figure, and a bare
   * figure in this layer means damage.
   */
  it("says which way the bar went, whatever the colour renders as", () => {
    expect(textFor(mend(5))).toBe("+5");
    expect(textFor(mend(1))).toBe("+1");
  });

  /**
   * **Green whoever it happened to**, unlike a blow. Red exists because your own
   * hit points are the thing you cannot afford to miss while reading the
   * traffic, and there is no equivalent fear about being healed — so a healer
   * reads their own tick and their partner's as one event.
   */
  it("is the same green for the viewer and for everybody else", () => {
    expect(classFor(mend(5, true))).toBe(classFor(mend(5, false)));
    expect(classFor(mend(5))).toContain("damage-number--mend");
  });

  /**
   * It never reads as `blocked`, and it never has to: a mend is only floated for
   * health that actually went in — see `../game/GameSession`'s `applyHealing` —
   * so there is no heal of nothing to find a word for.
   */
  it("is never the word a blow of nothing gets", () => {
    expect(classFor(mend(5))).not.toContain("damage-number--nothing");
  });
});
