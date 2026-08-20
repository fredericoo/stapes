import { describe, expect, it } from "vitest";
import type { StrikeState } from "../game/strike";
import { CELL_SIZE } from "../lib/types";
import { strikeLean, strikeOffset, STRIKE_REACH_PX } from "./strikeMotion";

/**
 * The pixels of a lean.
 *
 * Whether a body leans at all is `../game/strike`'s subject. This is only about
 * where the sprite goes once it has decided to.
 */

function strike(over: Partial<StrikeState> = {}): StrikeState {
  return { kind: "swing", dx: 1, dy: 0, dElev: 0, elapsedMs: 0, ...over };
}

/** Distance travelled from home, which is the figure the eye reads. */
function reach(offset: { ox: number; oy: number }): number {
  return Math.hypot(offset.ox, offset.oy);
}

describe("the shape of a lean", () => {
  it("starts and ends at home", () => {
    expect(strikeLean(0)).toBe(0);
    expect(strikeLean(1)).toBe(0);
  });

  it("reaches full stretch before halfway, then recovers", () => {
    expect(strikeLean(0.35)).toBe(1);
    // Out fast, back slow: a fifth of the strike before full stretch the body
    // is nearer home than it is a fifth of the strike after it. That asymmetry
    // is what reads as a blow rather than as a body bobbing.
    expect(strikeLean(0.15)).toBeLessThan(strikeLean(0.55));
  });

  /**
   * Progress arrives with a frame of interpolation added, so the last frame of
   * a strike routinely asks about a moment past the end of it.
   */
  it("holds at home past its own end", () => {
    expect(strikeLean(1.4)).toBe(0);
    expect(strikeLean(-0.2)).toBe(0);
  });
});

describe("where the sprite goes", () => {
  it("moves towards the target and comes back", () => {
    const east = strikeOffset(strike(), 0.35);
    expect(east.ox).toBe(STRIKE_REACH_PX);
    expect(east.oy).toBe(0);

    expect(strikeOffset(strike(), 0)).toEqual({ ox: 0, oy: 0 });
    expect(strikeOffset(strike(), 1)).toEqual({ ox: 0, oy: 0 });
  });

  it("leans the other way for a target the other way", () => {
    expect(strikeOffset(strike({ dx: 0, dy: -1 }), 0.35)).toEqual({
      ox: 0,
      oy: -STRIKE_REACH_PX,
    });
  });

  /**
   * A diagonal is one lean, not 1.41 of one. Scaling the axes independently
   * would send a corner strike a whole cell of travel — into the target's
   * square, where the two sprites read as swapped rather than as fighting.
   */
  it("travels the same distance at a corner as it does straight on", () => {
    const straight = reach(strikeOffset(strike(), 0.35));
    const corner = reach(strikeOffset(strike({ dx: 1, dy: 1 }), 0.35));

    expect(corner).toBeLessThan(CELL_SIZE);
    expect(Math.abs(corner - straight)).toBeLessThanOrEqual(1);
  });

  /**
   * The one target with no direction on the plan. A height unit is drawn up and
   * left, so the body it belongs to is somewhere to lean at even when it is
   * standing in the cell you are.
   */
  it("leans up-left at somebody directly overhead", () => {
    const up = strikeOffset(strike({ dx: 0, dy: 0, dElev: 1 }), 0.35);
    expect(up.ox).toBeLessThan(0);
    expect(up.oy).toBeLessThan(0);
    expect(reach(up)).toBeGreaterThan(0);
  });

  /**
   * A level is drawn one cell up-left and a height unit is half of that, so the
   * body standing on a crate to your east is drawn up *and* right of you — and
   * that, not the cell it occupies, is where the lean has to go.
   */
  it("leans up at a foe on a box and down at one in a pit", () => {
    const onBox = strikeOffset(strike({ dx: 1, dElev: 1 }), 0.35);
    expect(onBox.ox).toBeGreaterThan(0);
    expect(onBox.oy).toBeLessThan(0);

    const inPit = strikeOffset(strike({ dx: 1, dElev: -1 }), 0.35);
    expect(inPit.ox).toBeGreaterThan(0);
    expect(inPit.oy).toBeGreaterThan(0);

    // Same half-cell of travel either way: height tilts the lean, it does not
    // lengthen it.
    expect(Math.abs(reach(onBox) - reach(inPit))).toBeLessThanOrEqual(1);
  });

  /** Whole pixels: a sprite drawn on a half one has soft edges all fight. */
  it("lands on whole pixels", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const { ox, oy } = strikeOffset(strike({ dx: 1, dy: 1 }), t);
      expect(Number.isInteger(ox)).toBe(true);
      expect(Number.isInteger(oy)).toBe(true);
    }
  });
});
