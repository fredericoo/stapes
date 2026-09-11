import { describe, expect, it } from "vitest";
import type { CastRefusal } from "../game/casting";
import { cooldownShare, spellAppearance, spellPressable } from "./SpellBar";

/**
 * Which of the three appearances a stone wears, and whether pressing it sends
 * anything.
 *
 * The claim worth pinning down is the odd one: a stone refused for want of a
 * target reads as *ready* and presses, and everything else that is refused does
 * not. Everything above it in the component is React; this is the decision.
 */
describe("spellAppearance", () => {
  it("draws a castable stone ready", () => {
    expect(spellAppearance({ ok: true })).toBe("ready");
  });

  it("draws a cooling stone as cooling, since the ring is the point of it", () => {
    expect(spellAppearance({ ok: false, reason: "cooling" })).toBe("cooling");
  });

  it("draws a stone with nobody targeted ready, because the stone is fine", () => {
    expect(spellAppearance({ ok: false, reason: "noTarget" })).toBe("ready");
  });

  it.each<CastRefusal>(["empty", "mastery", "outOfRange"])(
    "collapses %s into one unavailable appearance",
    (reason) => {
      expect(spellAppearance({ ok: false, reason })).toBe("unavailable");
    },
  );
});

describe("cooldownShare", () => {
  const TOTAL_MS = 5600;

  it("is the whole ring for a stone just cast", () => {
    expect(cooldownShare(TOTAL_MS, TOTAL_MS)).toBe(1);
  });

  it("is the remaining fraction part-way through", () => {
    expect(cooldownShare(1400, TOTAL_MS)).toBe(0.25);
  });

  /** The ring aims one step below the last figure, which on the final step of
   * a 5.6s stone is 600 - 1000. */
  it("stops at empty rather than running backwards past the last step", () => {
    expect(cooldownShare(-400, TOTAL_MS)).toBe(0);
  });

  it("never draws more than a whole ring", () => {
    expect(cooldownShare(TOTAL_MS * 2, TOTAL_MS)).toBe(1);
  });

  it("draws nothing for a stone with no cooldown to divide by", () => {
    expect(cooldownShare(1000, 0)).toBe(0);
  });
});

describe("spellPressable", () => {
  it("sends a cast that would land", () => {
    expect(spellPressable({ ok: true })).toBe(true);
  });

  /** The press is what produces the sentence. @see `../game/notices` */
  it("sends one with nobody targeted, so the session can say why not", () => {
    expect(spellPressable({ ok: false, reason: "noTarget" })).toBe(true);
  });

  it.each<CastRefusal>(["empty", "cooling", "mastery", "outOfRange"])(
    "stops a press refused for %s, which the button already draws",
    (reason) => {
      expect(spellPressable({ ok: false, reason })).toBe(false);
    },
  );
});
