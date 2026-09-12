import { describe, expect, it } from "vitest";

import { progressFraction, windProgress } from "./progress";

/** Long enough that a quarter of it is a round number to read. */
const WHOLE_MS = 4_000;

/** Past the end or before the start, as two unsynchronised clocks leave it. */
const OVERSHOOT_MS = 100;

describe("how far through something is", () => {
  it("runs from nothing to done", () => {
    const at = (remainingMs: number) =>
      progressFraction({ remainingMs, durationMs: WHOLE_MS });

    expect(at(WHOLE_MS)).toBe(0);
    expect(at(WHOLE_MS / 4)).toBe(0.75);
    expect(at(0)).toBe(1);
  });

  it("stays inside the bar when a clock overshoots", () => {
    const at = (remainingMs: number) =>
      progressFraction({ remainingMs, durationMs: WHOLE_MS });

    expect(at(-OVERSHOOT_MS)).toBe(1);
    expect(at(WHOLE_MS + OVERSHOOT_MS)).toBe(0);
  });

  it("calls something that takes no time at all done", () => {
    expect(progressFraction({ remainingMs: 0, durationMs: 0 })).toBe(1);
  });
});

describe("winding", () => {
  it("takes the frame off in place, so the value keeps its identity", () => {
    const progress = { remainingMs: WHOLE_MS, durationMs: WHOLE_MS };
    const held = progress;

    windProgress(progress, 1_000);

    expect(held.remainingMs).toBe(3_000);
  });

  it("floors at zero rather than running negative", () => {
    const progress = { remainingMs: 100, durationMs: WHOLE_MS };

    windProgress(progress, WHOLE_MS);

    expect(progress.remainingMs).toBe(0);
  });
});
