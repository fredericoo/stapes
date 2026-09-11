import { describe, expect, it } from "vitest";
import type { CastRefusal } from "../game/casting";
import {
  castTimeNote,
  cooldownShare,
  spellAppearance,
  spellPressable,
} from "./SpellBar";

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

  it.each<CastRefusal>(["empty", "casting", "mastery", "outOfRange", "blocked"])(
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

  it.each<CastRefusal>(["empty", "cooling", "mastery", "outOfRange", "blocked"])(
    "stops a press refused for %s, which the button already draws",
    (reason) => {
      expect(spellPressable({ ok: false, reason })).toBe(false);
    },
  );
});

/**
 * What a button says about the time a cast costs.
 *
 * Said rather than drawn — the picture of a cast is the bar over the caster's
 * head once they have pressed — so this is the whole of the button's side of it.
 */
describe("castTimeNote", () => {
  it("says nothing for an instant stone, which is nearly all of them", () => {
    expect(castTimeNote(0)).toBe("");
  });

  it("reads a whole cast in seconds", () => {
    expect(castTimeNote(3_000)).toBe("3s to cast");
  });

  /**
   * A cast scaled by a caster's masteries is rarely a whole number of seconds,
   * and a tenth is the grain a bar can be read at.
   */
  it("keeps a tenth of a second, and no more", () => {
    expect(castTimeNote(1_500)).toBe("1.5s to cast");
    expect(castTimeNote(1_530)).toBe("1.5s to cast");
  });
});
