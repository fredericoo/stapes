import { describe, expect, it } from "vitest";
import {
  clampWalkSpeedPercent,
  MAX_WALK_SPEED_PERCENT,
  MIN_WALK_SPEED_PERCENT,
  walkDurationFrom,
} from "./walkSpeed";

/**
 * The arithmetic both sides of the wire run to time a step. It is asserted on
 * its own because a disagreement here is a body that walks at one pace in the
 * simulation and another on screen, and that is invisible until somebody is
 * standing in a bog.
 */
describe("a pace moved by a percentage", () => {
  const BASE = 200;

  it("leaves a body that nothing is touching at its own pace", () => {
    expect(walkDurationFrom(BASE, 0)).toBe(BASE);
  });

  /**
   * The percentage is a change in speed, not in milliseconds — which is the
   * whole reason it divides. Half the speed is twice the time.
   */
  it("turns half the speed into twice the time", () => {
    expect(walkDurationFrom(BASE, -50)).toBe(BASE * 2);
  });

  it("turns twice the speed into half the time", () => {
    expect(walkDurationFrom(BASE, 100)).toBe(BASE / 2);
  });

  /**
   * The pair a percentage of the *duration* would get wrong: slowing by half
   * and hurrying by half are not the same size of step, and neither should
   * land back where it started.
   */
  it("reads the two directions as speeds rather than as durations", () => {
    expect(walkDurationFrom(BASE, 50)).toBe(133);
    expect(walkDurationFrom(BASE, -50)).toBe(400);
  });

  it("holds the total inside the band", () => {
    expect(walkDurationFrom(BASE, -100)).toBe(walkDurationFrom(BASE, MIN_WALK_SPEED_PERCENT));
    expect(walkDurationFrom(BASE, 10_000)).toBe(walkDurationFrom(BASE, MAX_WALK_SPEED_PERCENT));
  });

  /**
   * The floor that matters: at -100 the divisor is zero, and a body that can
   * never finish a step is one nothing in the game can free.
   */
  it("never stops a body walking", () => {
    expect(walkDurationFrom(BASE, -100)).toBeLessThan(Infinity);
    expect(clampWalkSpeedPercent(-100)).toBe(MIN_WALK_SPEED_PERCENT);
  });

  it("never times a step at nothing", () => {
    expect(walkDurationFrom(1, MAX_WALK_SPEED_PERCENT)).toBeGreaterThan(0);
  });
});
