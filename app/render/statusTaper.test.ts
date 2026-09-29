import { describe, expect, it } from "vitest";
import { SmoothedRemaining, taperKey } from "./statusTaper";

describe("smoothing what the wire says", () => {
  it("returns what it was told, the first time it is told", () => {
    const clocks = new SmoothedRemaining();
    clocks.beginFrame(16);
    expect(clocks.read(taperKey("me", "poison"), 4_000)).toBe(4_000);
    clocks.endFrame();
  });

  it("carries the figure down between messages", () => {
    const clocks = new SmoothedRemaining();
    const key = taperKey("me", "poison");

    clocks.beginFrame(0);
    clocks.read(key, 4_000);
    clocks.endFrame();

    for (let i = 0; i < 3; i++) {
      clocks.beginFrame(100);
      clocks.read(key, 4_000);
      clocks.endFrame();
    }
    clocks.beginFrame(0);
    expect(clocks.read(key, 4_000)).toBe(3_700);
    clocks.endFrame();
  });

  it("re-anchors the moment a new figure arrives", () => {
    const clocks = new SmoothedRemaining();
    const key = taperKey("me", "poison");

    clocks.beginFrame(0);
    clocks.read(key, 4_000);
    clocks.endFrame();
    clocks.beginFrame(500);
    clocks.read(key, 4_000);
    clocks.endFrame();

    clocks.beginFrame(0);
    expect(clocks.read(key, 3_000)).toBe(3_000);
    clocks.endFrame();
  });

  it("compares against the last snapshot, not against the carried value", () => {
    const clocks = new SmoothedRemaining();
    const key = taperKey("me", "burn");

    clocks.beginFrame(0);
    clocks.read(key, 2_000);
    clocks.endFrame();
    for (let i = 0; i < 5; i++) {
      clocks.beginFrame(50);
      clocks.read(key, 2_000);
      clocks.endFrame();
    }
    clocks.beginFrame(0);
    expect(clocks.read(key, 2_000)).toBe(1_750);
    clocks.endFrame();
  });

  it("ages a status once a frame however often it is read", () => {
    const clocks = new SmoothedRemaining();
    const key = taperKey("me", "burn");

    clocks.beginFrame(0);
    clocks.read(key, 1_000);
    clocks.endFrame();

    clocks.beginFrame(100);
    expect(clocks.read(key, 1_000)).toBe(900);
    expect(clocks.read(key, 1_000)).toBe(900);
    clocks.endFrame();
  });

  it("never carries below nothing", () => {
    const clocks = new SmoothedRemaining();
    const key = taperKey("me", "poison");
    clocks.beginFrame(0);
    clocks.read(key, 50);
    clocks.endFrame();

    clocks.beginFrame(5_000);
    expect(clocks.read(key, 50)).toBe(0);
    clocks.endFrame();
  });

  it("forgets a status nobody asked about", () => {
    const clocks = new SmoothedRemaining();
    clocks.beginFrame(0);
    clocks.read(taperKey("me", "poison"), 1_000);
    clocks.read(taperKey("rat", "burn"), 2_000);
    clocks.endFrame();
    expect(clocks.size).toBe(2);

    clocks.beginFrame(16);
    clocks.read(taperKey("me", "poison"), 1_000);
    clocks.endFrame();
    expect(clocks.size).toBe(1);
  });

  it("keeps one bearer's status apart from another's", () => {
    const clocks = new SmoothedRemaining();
    clocks.beginFrame(0);
    expect(clocks.read(taperKey("me", "poison"), 1_000)).toBe(1_000);
    expect(clocks.read(taperKey("rat", "poison"), 9_000)).toBe(9_000);
    clocks.endFrame();
  });
});
