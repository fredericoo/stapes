import { describe, expect, it } from "vitest";
import {
  HEALTH_BAR_BRICKS,
  HEALTH_BAR_STOPS,
  healthBarColor,
  healthBarFillBricks,
  healthFraction,
} from "./healthBar";

/**
 * The ramp, asserted as an ordering rather than as four hex values.
 *
 * Pinning the exact colours would make this a change-detector: the point is not
 * that "hurt" is `#d12d2d`, it is that a bar goes green, yellow, red, dark red
 * and never back the other way. The one reading worth pinning is the last hit
 * point, because rounding it away is the failure a player actually notices.
 */

describe("how full a bar is", () => {
  it("clamps to the ends", () => {
    expect(healthFraction(-5, 10)).toBe(0);
    expect(healthFraction(50, 10)).toBe(1);
  });

  it("survives a maximum of zero rather than dividing by it", () => {
    expect(healthFraction(0, 0)).toBe(0);
  });
});

describe("the colour ramp", () => {
  it("passes through four distinct colours on the way down", () => {
    const seen = new Set(
      [1, 0.5, 0.25, 0.05].map((fraction) => healthBarColor(fraction)),
    );
    expect(seen.size).toBe(HEALTH_BAR_STOPS.length);
  });

  it("only ever changes colour in one direction as health falls", () => {
    let previous = healthBarColor(1);
    const changes: string[] = [];
    for (let step = 100; step >= 0; step--) {
      const color = healthBarColor(step / 100);
      if (color !== previous) changes.push(color);
      previous = color;
    }
    // Three transitions between four stops, and no colour revisited — a ramp
    // that flickered back to green on the way down would still be "four
    // colours" by the test above.
    expect(changes).toHaveLength(HEALTH_BAR_STOPS.length - 1);
    expect(new Set(changes).size).toBe(changes.length);
  });

  it("is at its darkest when nearly gone and its brightest when full", () => {
    expect(healthBarColor(0.01)).toBe(HEALTH_BAR_STOPS[0]!.color);
    expect(healthBarColor(1)).toBe(
      HEALTH_BAR_STOPS[HEALTH_BAR_STOPS.length - 1]!.color,
    );
  });
});

describe("the fill", () => {
  it("spans the whole track at full health and none of it at zero", () => {
    expect(healthBarFillBricks(1)).toBe(HEALTH_BAR_BRICKS);
    expect(healthBarFillBricks(0)).toBe(0);
  });

  /**
   * The one thing rounding must not do downward. A creature on its last hit
   * point out of five hundred is one you can still kill, and an empty bar over
   * it says the opposite.
   */
  it("keeps a brick for the last hit point of a big pool", () => {
    expect(healthBarFillBricks(healthFraction(1, 500))).toBe(1);
  });

  /**
   * And the one it must not do upward. A bar is only drawn once something has
   * been taken off, so rounding 99% to a completely full track would hide the
   * very thing the bar appeared to say.
   */
  it("never reads as full while anything is missing", () => {
    expect(healthBarFillBricks(0.999)).toBeLessThan(HEALTH_BAR_BRICKS);
    expect(healthBarFillBricks(healthFraction(499, 500))).toBeLessThan(
      HEALTH_BAR_BRICKS,
    );
  });

  it("stays on the brick grid, and inside the track", () => {
    for (let hp = 0; hp <= 20; hp++) {
      const bricks = healthBarFillBricks(healthFraction(hp, 20));
      expect(Number.isInteger(bricks)).toBe(true);
      expect(bricks).toBeGreaterThanOrEqual(0);
      expect(bricks).toBeLessThanOrEqual(HEALTH_BAR_BRICKS);
    }
  });

  it("grows as health does", () => {
    let previous = -1;
    for (let hp = 0; hp <= 20; hp++) {
      const bricks = healthBarFillBricks(healthFraction(hp, 20));
      expect(bricks).toBeGreaterThanOrEqual(previous);
      previous = bricks;
    }
  });
});
