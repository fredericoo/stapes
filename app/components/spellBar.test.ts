import { describe, expect, it } from "vitest";
import type { CastRefusal } from "../game/casting";
import { spellAppearance, spellPressable } from "./SpellBar";

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

  it.each<CastRefusal>(["empty", "mastery", "outOfRange", "blocked"])(
    "collapses %s into one unavailable appearance",
    (reason) => {
      expect(spellAppearance({ ok: false, reason })).toBe("unavailable");
    },
  );
});

describe("spellPressable", () => {
  it("sends a cast that would land", () => {
    expect(spellPressable({ ok: true })).toBe(true);
  });

  /** The press is what produces the sentence. @see `../game/notices` */
  it("sends one with nobody targeted, so the session can say why not", () => {
    expect(spellPressable({ ok: false, reason: "noTarget" })).toBe(true);
  });

  it.each<CastRefusal>(["empty", "cooling", "mastery", "outOfRange", "blocked"])(
    "stops a press refused for %s, which the button already draws",
    (reason) => {
      expect(spellPressable({ ok: false, reason })).toBe(false);
    },
  );
});
