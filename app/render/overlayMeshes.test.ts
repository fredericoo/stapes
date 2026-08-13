import { describe, expect, it } from "vitest";
import { PULSE_PERIOD_MS, pulseAlphaAt } from "./overlayMeshes";

/**
 * How a chosen outline breathes.
 *
 * Asserted rather than eyeballed because both ends of the curve are decisions
 * with reasons: it never goes out, so a target is never briefly indistinguishable
 * from nothing, and it comes all the way back up, so the outline reads as one
 * breath rather than as a light that dimmed and stayed dim.
 */
describe("pulseAlphaAt", () => {
  it("never goes out", () => {
    for (let ms = 0; ms < PULSE_PERIOD_MS * 3; ms += 17) {
      expect(pulseAlphaAt(ms)).toBeGreaterThan(0);
    }
  });

  it("comes back to full, and dips well below it", () => {
    const samples = [];
    for (let ms = 0; ms < PULSE_PERIOD_MS * 3; ms += 17) {
      samples.push(pulseAlphaAt(ms));
    }

    expect(Math.max(...samples)).toBeCloseTo(1, 2);
    expect(Math.min(...samples)).toBeLessThan(0.5);
  });

  /** One cycle, repeating: an outline rebuilt mid-walk resumes where it was. */
  it("repeats", () => {
    const intoTheCycleMs = 350;
    expect(pulseAlphaAt(PULSE_PERIOD_MS + intoTheCycleMs)).toBeCloseTo(
      pulseAlphaAt(intoTheCycleMs),
      5,
    );
  });

  it("starts at its dimmest and climbs", () => {
    expect(pulseAlphaAt(0)).toBeLessThan(pulseAlphaAt(200));
  });
});
