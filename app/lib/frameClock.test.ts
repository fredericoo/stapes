/**
 * The one function that answers "which frame is on screen right now".
 *
 * Both renderers read it — once when a mesh is built and again every tick — and
 * the two answers agreeing is what keeps a walk cycle steady across the rebuild
 * that every step triggers. When the build path answered "frame 0" instead,
 * walking restarted the cycle several times a second.
 */
import { describe, expect, it } from "vitest";
import { frameAtTime, frameIndexAtTime, type Frame } from "./types";

const FRAME_MS = 200;

function frames(count: number, durationMs = FRAME_MS): Frame[] {
  return Array.from({ length: count }, (_, i) => ({
    sprite: {
      tilesetId: "people",
      rect: { x: i, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    },
    durationMs,
  }));
}

describe("frameIndexAtTime", () => {
  it("holds each frame for its authored duration", () => {
    const walk = frames(4);
    expect(frameIndexAtTime(walk, 0)).toBe(0);
    expect(frameIndexAtTime(walk, FRAME_MS - 1)).toBe(0);
    expect(frameIndexAtTime(walk, FRAME_MS)).toBe(1);
    expect(frameIndexAtTime(walk, FRAME_MS * 2)).toBe(2);
    expect(frameIndexAtTime(walk, FRAME_MS * 3)).toBe(3);
  });

  it("loops at the end of the cycle", () => {
    const walk = frames(4);
    expect(frameIndexAtTime(walk, FRAME_MS * 4)).toBe(0);
    expect(frameIndexAtTime(walk, FRAME_MS * 4 + 1)).toBe(0);
    expect(frameIndexAtTime(walk, FRAME_MS * 9)).toBe(1);
  });

  it("respects uneven durations", () => {
    const [dark] = frames(1, 50);
    const [lit] = frames(1, 500);
    const flicker: Frame[] = [dark!, lit!];
    expect(frameIndexAtTime(flicker, 49)).toBe(0);
    expect(frameIndexAtTime(flicker, 50)).toBe(1);
    expect(frameIndexAtTime(flicker, 549)).toBe(1);
    expect(frameIndexAtTime(flicker, 550)).toBe(0);
  });

  it("is stable for a still sprite and for no sprite at all", () => {
    expect(frameIndexAtTime(frames(1), 12_345)).toBe(0);
    expect(frameIndexAtTime([], 12_345)).toBe(0);
  });

  /**
   * Two placements of one sprite share a clock rather than each starting from
   * whenever they were built — which is the property that lets a rebuilt mesh
   * pick the cycle back up where it left off instead of restarting it.
   */
  it("depends only on the clock, not on when anything started", () => {
    const walk = frames(4);
    const t = 7 * FRAME_MS + 37;
    expect(frameIndexAtTime(walk, t)).toBe(frameIndexAtTime(frames(4), t));
  });
});

describe("frameAtTime", () => {
  it("returns the frame its index names", () => {
    const walk = frames(4);
    expect(frameAtTime(walk, FRAME_MS * 2 + 10)).toBe(walk[2]);
    expect(frameAtTime(walk, FRAME_MS * 6)).toBe(walk[2]);
  });

  it("has nothing to return for an empty frame list", () => {
    expect(frameAtTime([], 0)).toBeUndefined();
  });
});
