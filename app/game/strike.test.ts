import { describe, expect, it } from "vitest";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import type { ReachPoint } from "./distance";
import { dodgeAway, outranksSwing, swingToward } from "./strike";

/** Every swing below is a melee one unless it says otherwise. */
const MELEE = false;
const RANGED = true;

/**
 * Which way the two bodies in a blow move, and which blows move them at all.
 *
 * Everything about how a lean is *drawn* lives in `../render/strikeMotion`, and
 * everything about whether the blow lands lives in `./combat`. What is asserted
 * here is the direction each body travels and the band the swinger's own lean is
 * owed inside.
 */

function at(x: number, y: number, elevAbs = 0): ReachPoint {
  return { x, y, elevAbs };
}

/** Half a level, which is the step a crate or a kerb puts under somebody. */
const HALF_LEVEL = HEIGHT_PER_LEVEL / 2;

describe("who is close enough to lean at", () => {
  it("takes the delta to a neighbour", () => {
    expect(swingToward(at(4, 4), at(5, 4), MELEE)).toEqual({
      kind: "swing",
      dx: 1,
      dy: 0,
      dElev: 0,
      elapsedMs: 0,
    });
  });

  it("takes a corner too, which is what the band exists for", () => {
    expect(swingToward(at(0, 0), at(-1, 1), MELEE)?.dx).toBe(-1);
    expect(swingToward(at(0, 0), at(-1, 1), MELEE)?.dy).toBe(1);
  });

  /**
   * The melee band is half a level either way — see `./distance` — so the body
   * standing on the crate beside you is inside it, and gets a lean.
   */
  it("takes the body half a level up, in the same cell or the next one", () => {
    expect(swingToward(at(0, 0), at(0, 0, HALF_LEVEL), MELEE)?.dElev).toBe(HALF_LEVEL);
    expect(swingToward(at(0, 0), at(1, 0, HALF_LEVEL), MELEE)).not.toBeNull();
  });

  /** The far corner of the melee box: diagonal and up a crate, still a lean. */
  it("takes the last body inside melee reach", () => {
    expect(swingToward(at(0, 0), at(1, 1, HALF_LEVEL), MELEE)).not.toBeNull();
  });

  /**
   * A blow struck from further off than an arm reaches. It is a real swing and
   * it does real damage — a bow is exactly this — but leaning half a tile at
   * somebody two cells away would claim a contact that never happened.
   */
  it("refuses anything past arm's reach", () => {
    expect(swingToward(at(0, 0), at(2, 0), MELEE)).toBeNull();
    // A whole level up, which melee cannot reach either: the band is half a
    // level, and a storey is two height units. @see ./distance
    expect(swingToward(at(0, 0), at(0, 0, HEIGHT_PER_LEVEL), MELEE)).toBeNull();
  });

  /**
   * The gate the distance one cannot stand in for: an archer with somebody in
   * their face is at point-blank range and still owes no lean, because what
   * travels is the arrow. @see swingToward
   */
  it("refuses a ranged weapon at any distance at all", () => {
    expect(swingToward(at(0, 0), at(1, 0), RANGED)).toBeNull();
    expect(swingToward(at(4, 4), at(4, 5), RANGED)).toBeNull();
  });

  /** Two bodies in one place: a direction of nothing is not an animation. */
  it("refuses a swing at exactly where the swinger is", () => {
    expect(swingToward(at(3, 7), at(3, 7), MELEE)).toBeNull();
  });
});

describe("getting out of the way", () => {
  /** Away, which is the whole of the reading: something came from over there. */
  it("throws the defender back along the line of the blow", () => {
    expect(dodgeAway(at(5, 5), at(4, 5))).toMatchObject({
      kind: "dodge",
      dx: 1,
      dy: 0,
    });
  });

  /**
   * No range gate, unlike a swing. This is the only account of a dodge anybody
   * gets now, so an arrow avoided across the room still has to show something.
   */
  it("hops back from an archer it could never have reached", () => {
    expect(dodgeAway(at(0, 0), at(0, 9))).toMatchObject({ dy: -9 });
  });

  it("drops down off somebody swinging up at it", () => {
    expect(dodgeAway(at(0, 0), at(0, 0, -HALF_LEVEL))?.dElev).toBe(HALF_LEVEL);
  });
});

describe("a body that dodges and swings on one tick", () => {
  const dodge = () => dodgeAway(at(1, 0), at(0, 0))!;

  it("keeps the dodge nobody has seen a frame of yet", () => {
    expect(outranksSwing(dodge())).toBe(true);
  });

  it("gives way once the dodge has been drawn, and to nothing else", () => {
    expect(outranksSwing({ ...dodge(), elapsedMs: 33 })).toBe(false);
    expect(outranksSwing(swingToward(at(0, 0), at(1, 0), MELEE))).toBe(false);
    expect(outranksSwing(null)).toBe(false);
  });
});
