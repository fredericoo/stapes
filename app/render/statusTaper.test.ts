import { describe, expect, it } from "vitest";
import { SmoothedRemaining, taperKey } from "./statusTaper";

/**
 * Carrying a countdown between the moments anybody says what it is.
 *
 * The case that matters is the online one: the wire speaks about once a second,
 * and a fade driven straight off it is a staircase. Everything here is about the
 * carry — that it happens, that a new figure wins, and that it cannot run twice
 * in a frame.
 */

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

    // Three frames of silence from the server: the same stale 4000 arrives, and
    // the local figure has to keep moving or the fade is a staircase.
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

    // The server speaks. Whatever local time thought, this is the answer.
    clocks.beginFrame(0);
    expect(clocks.read(key, 3_000)).toBe(3_000);
    clocks.endFrame();
  });

  it("compares against the last snapshot, not against the carried value", () => {
    // The trap: the carried value drifts away by design, so comparing the
    // snapshot to *it* would re-anchor every frame and smooth nothing.
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
    // Two readers per frame: the tint and plume pass, then the light pass. A
    // clock aged by each would run the fade at double speed.
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

    // The rat died, or wore it off. Its clock goes with it.
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
