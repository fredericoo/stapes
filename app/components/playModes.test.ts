import { describe, expect, it } from "vitest";
import { modeAfterAttackKey, modeInForce } from "./usePlayModes";

/**
 * What a tap on the world means, and the two inputs that argue about it.
 *
 * The interesting cases are all about shift, because shift is the one input that
 * is *momentary* against two that latch. A key that could not be told apart from
 * a button is how the old pair of switches ended up cancelling each other, and
 * these are the cases that used to go wrong.
 */

describe("what mode is in force", () => {
  it("is whatever was chosen while no key is down", () => {
    expect(modeInForce("interact", false)).toBe("interact");
    expect(modeInForce("attack", false)).toBe("attack");
  });

  it("is inspect while shift is held, whatever was chosen", () => {
    expect(modeInForce("interact", true)).toBe("inspect");
    expect(modeInForce("attack", true)).toBe("inspect");
  });

  /** The whole of "revert to the previous one on release". */
  it("goes back to the chosen mode when shift comes up", () => {
    const chosen = "attack";
    expect(modeInForce(chosen, true)).toBe("inspect");
    expect(modeInForce(chosen, false)).toBe("attack");
  });

  /**
   * A tap of shift must not put out a mode a *button* lit. That is the failure
   * the two-boolean shape exists to make impossible, so it is asserted rather
   * than left to the shape being obviously right.
   */
  it("does not clear a latched inspect when shift comes up", () => {
    expect(modeInForce("inspect", true)).toBe("inspect");
    expect(modeInForce("inspect", false)).toBe("inspect");
  });
});

describe("the attack key", () => {
  it("draws the sword from anywhere else", () => {
    expect(modeAfterAttackKey("interact")).toBe("attack");
    expect(modeAfterAttackKey("inspect")).toBe("attack");
  });

  /** Pressed again it puts the sword away, and lands somewhere usable. */
  it("puts it away again, back to plain interaction", () => {
    expect(modeAfterAttackKey("attack")).toBe("interact");
  });
});
