import { describe, expect, it } from "vitest";
import type { FrameReport } from "../net/frameReport";
import { groupFrameReports } from "./frameSummary";

function report(over: Partial<FrameReport> & { gpu?: string }): FrameReport {
  return {
    tab: "tab",
    build: "aaaaaaa1",
    spanMs: 0,
    frames: 0,
    buckets: [0, 0, 0, 0, 0, 0, 0, 0],
    worstMs: 0,
    gaps: 0,
    phases: {},
    canvas: "1280x720",
    lighting: true,
    area: null,
    device: {
      userAgent: "",
      platform: "Linux",
      mobile: false,
      screen: "1920x1080",
      viewport: "1280x720",
      devicePixelRatio: 1,
      cores: null,
      memoryGb: null,
      gpu: over.gpu ?? "fast",
    },
    ...over,
  };
}

describe("grouping frame reports", () => {
  it("adds the counts of a group's reports and puts the slowest group first", () => {
    const groups = groupFrameReports(
      [
        report({ tab: "a", gpu: "fast", buckets: [0, 0, 1000, 0, 0, 0, 0, 0], worstMs: 18 }),
        report({ tab: "b", gpu: "slow", buckets: [0, 0, 500, 0, 0, 100, 0, 0], worstMs: 55 }),
        report({ tab: "b", gpu: "slow", buckets: [0, 0, 300, 0, 0, 0, 0, 100], worstMs: 400 }),
      ],
      "gpu",
    );

    expect(groups).toEqual([
      {
        key: "slow",
        tabs: 1,
        frames: 1000,
        p50Ms: 19,
        p95Ms: Infinity,
        p99Ms: Infinity,
        slowShare: 0.2,
        worstMs: 400,
      },
      {
        key: "fast",
        tabs: 1,
        frames: 1000,
        p50Ms: 19,
        p95Ms: 19,
        p99Ms: 19,
        slowShare: 0,
        worstMs: 18,
      },
    ]);
  });
});
