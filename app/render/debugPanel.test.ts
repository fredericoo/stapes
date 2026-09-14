import { describe, expect, it } from "vitest";
import { panelRows } from "./debugPanel";
import type { DebugReading } from "./WorldRenderer";

const READING: DebugReading = {
  meshChunks: 38,
  meshColumns: 9,
  meshReachCells: 13,
  lightChunks: 7,
  lightStale: 2,
  lightReachCells: 12,
  heldColumns: 109,
  heldReachCells: 124,
  drawCalls: 248,
  triangles: 40374,
};

describe("the debug panel", () => {
  it("says what each window is and how far past the view it reaches", () => {
    const rows = panelRows(3, READING);
    expect(rows.title).toContain("×3");
    expect(rows.mesh).toContain("9 cols");
    expect(rows.mesh).toContain("38 chunks");
    expect(rows.mesh).toContain("+13c");
    expect(rows.light).toContain("2 stale");
    expect(rows.held).toContain("109 cols");
    expect(rows.held).toContain("+124c");
    expect(rows.draws).toContain("248 calls");
  });

  /**
   * A client that has been sent nothing yet is a real state for the frame or
   * two after a join, and "+0c" would read as "the subscription is exactly the
   * view", which is the opposite of what is happening.
   */
  it("says it is waiting rather than claiming a reach of nothing", () => {
    const rows = panelRows(3, { ...READING, heldReachCells: null });
    expect(rows.held).toContain("waiting");
    expect(rows.held).not.toContain("+0c");
  });

  it("fills every row before there is a frame to report on", () => {
    const rows = panelRows(1, null);
    for (const value of Object.values(rows)) expect(value.length).toBeGreaterThan(0);
    expect(rows.title).toContain("×1");
  });
});
