import { describe, expect, it } from "vitest";
import {
  clampWalkSpeedPercent,
  MAX_WALK_SPEED_PERCENT,
  MIN_WALK_SPEED_PERCENT,
  walkDurationFrom,
} from "./walkSpeed";

describe("a pace moved by a percentage", () => {
  const BASE = 200;

  it("leaves a body that nothing is touching at its own pace", () => {
    expect(walkDurationFrom(BASE, 0)).toBe(BASE);
  });

  it("turns half the speed into twice the time", () => {
    expect(walkDurationFrom(BASE, -50)).toBe(BASE * 2);
  });

  it("turns twice the speed into half the time", () => {
    expect(walkDurationFrom(BASE, 100)).toBe(BASE / 2);
  });

  it("reads the two directions as speeds rather than as durations", () => {
    expect(walkDurationFrom(BASE, 50)).toBe(133);
    expect(walkDurationFrom(BASE, -50)).toBe(400);
  });

  it("holds the total inside the band", () => {
    expect(walkDurationFrom(BASE, -100)).toBe(walkDurationFrom(BASE, MIN_WALK_SPEED_PERCENT));
    expect(walkDurationFrom(BASE, 10_000)).toBe(walkDurationFrom(BASE, MAX_WALK_SPEED_PERCENT));
  });

  it("never stops a body walking", () => {
    expect(walkDurationFrom(BASE, -100)).toBeLessThan(Infinity);
    expect(clampWalkSpeedPercent(-100)).toBe(MIN_WALK_SPEED_PERCENT);
  });

  it("never times a step at nothing", () => {
    expect(walkDurationFrom(1, MAX_WALK_SPEED_PERCENT)).toBeGreaterThan(0);
  });
});
