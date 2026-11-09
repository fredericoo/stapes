import { describe, expect, it } from "vitest";
import { FRAME_BUCKET_EDGES_MS, framePercentileMs } from "../net/frameReport";
import { FrameMeter } from "./frameMeter";

describe("a frame meter", () => {
  it("puts a missed frame in a later bucket than the display's own rate", () => {
    const meter = new FrameMeter();
    for (let i = 0; i < 97; i++) meter.frame(16.7);
    for (let i = 0; i < 3; i++) meter.frame(33.4);

    const span = meter.drain()!;

    expect(span.frames).toBe(100);
    expect(span.worstMs).toBe(33);
    expect(framePercentileMs(span.buckets, 0.5)).toBe(FRAME_BUCKET_EDGES_MS[2]);
    expect(framePercentileMs(span.buckets, 0.99)).toBe(FRAME_BUCKET_EDGES_MS[4]);
  });

  it("counts a tab that was not being drawn as a gap, not as a slow frame", () => {
    const meter = new FrameMeter();
    meter.frame(16.7);
    meter.frame(45_000);

    expect(meter.drain()).toMatchObject({ frames: 1, gaps: 1, worstMs: 17, spanMs: 17 });
  });

  it("has nothing to report until a frame is drawn, and starts over once drained", () => {
    const meter = new FrameMeter();
    expect(meter.drain()).toBeNull();

    meter.frame(8);
    meter.drain();

    expect(meter.drain()).toBeNull();
  });
});
