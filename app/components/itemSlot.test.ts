import { describe, expect, it } from "vitest";
import { slotAppearance } from "./ItemSlot";

/**
 * What a square looks like, which is a question about precedence and nothing
 * else: every state below is true of some square at some point, and several are
 * true at once all the time. Everything above it in the component is React;
 * this is the decision — the same arrangement `./SpellBar`'s `spellAppearance`
 * is asserted under.
 */
const NOTHING_HAPPENING = {
  isOver: false,
  wouldTake: false,
  isSource: false,
  isOpen: false,
  locked: false,
  idle: false,
  filled: false,
};

describe("slotAppearance", () => {
  it("draws an empty square as empty and a full one as filled", () => {
    expect(slotAppearance(NOTHING_HAPPENING)).toBe("empty");
    expect(slotAppearance({ ...NOTHING_HAPPENING, filled: true })).toBe("filled");
  });

  it("draws an open container as open, over merely being full", () => {
    expect(
      slotAppearance({ ...NOTHING_HAPPENING, filled: true, isOpen: true }),
    ).toBe("open");
  });

  it("draws a cooling stone as locked, over merely being full", () => {
    expect(
      slotAppearance({ ...NOTHING_HAPPENING, filled: true, locked: true }),
    ).toBe("locked");
  });

  /**
   * The precedence that matters: a drag in progress answers "will it land
   * here", and a square that went on advertising a cooling stone or an open bag
   * while something hovered over it would be answering a question nobody is
   * asking.
   */
  it("lets a drag speak over everything a square is otherwise", () => {
    const busy = {
      ...NOTHING_HAPPENING,
      filled: true,
      isOpen: true,
      locked: true,
      idle: true,
    };
    expect(slotAppearance({ ...busy, isOver: true })).toBe("landing");
    expect(slotAppearance({ ...busy, wouldTake: true })).toBe("candidate");
    expect(slotAppearance({ ...busy, isSource: true })).toBe("source");
  });

  /**
   * The quiet one, and the reason it sits this low: a square that is doing
   * nothing is still a square you might be about to drop something on, or one
   * holding a stone that cannot be moved, and both of those are what a player
   * is asking about at the moment they are true.
   */
  it("draws a square whose contents nothing reads as idle", () => {
    expect(slotAppearance({ ...NOTHING_HAPPENING, filled: true, idle: true })).toBe(
      "idle",
    );
    expect(
      slotAppearance({
        ...NOTHING_HAPPENING,
        filled: true,
        idle: true,
        locked: true,
      }),
    ).toBe("locked");
  });

  it("puts the square under the pointer above the rest of the legal ones", () => {
    expect(
      slotAppearance({ ...NOTHING_HAPPENING, isOver: true, wouldTake: true }),
    ).toBe("landing");
  });
});
