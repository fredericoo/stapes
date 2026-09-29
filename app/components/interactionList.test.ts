import { describe, expect, it } from "vitest";
import { blockReason, drawnBlockReason, fillElapsedMs } from "./InteractionList";

function pull(remainingMs: number, durationMs = 5_000) {
  return { key: "0:1,0|bush", remainingMs, durationMs };
}

describe("how far through a pull a row is", () => {
  it("is nothing at the moment it starts", () => {
    expect(fillElapsedMs(pull(5_000))).toBe(0);
  });

  it("is the whole duration once it has finished", () => {
    expect(fillElapsedMs(pull(0))).toBe(5_000);
  });

  it("is the difference in between", () => {
    expect(fillElapsedMs(pull(1_500))).toBe(3_500);
  });

  it("clamps a remainder that overshoots its own duration", () => {
    expect(fillElapsedMs(pull(9_000))).toBe(0);
  });

  it("clamps a remainder that has gone negative", () => {
    expect(fillElapsedMs(pull(-2_000))).toBe(5_000);
  });

  it("is nothing for a pull with no duration at all", () => {
    expect(fillElapsedMs(pull(0, 0))).toBe(0);
  });
});

describe("how far through the wait before a blow a fight row is", () => {
  const INTERVAL_MS = 1_200;
  const wait = (remainingMs: number) => ({
    remainingMs,
    durationMs: INTERVAL_MS,
  });

  it("is half the interval when a fight opens, because the windup is half of one", () => {
    expect(fillElapsedMs(wait(INTERVAL_MS / 2))).toBe(INTERVAL_MS / 2);
  });

  it("is the whole interval when the blow is due", () => {
    expect(fillElapsedMs(wait(0))).toBe(INTERVAL_MS);
  });

  it("is nothing when a blow has just been thrown", () => {
    expect(fillElapsedMs(wait(INTERVAL_MS))).toBe(0);
  });
});

describe("why a blocked row is grey", () => {
  const WORKING = {
    kind: "working",
    extraction: { key: "0:1,0|bush", remainingMs: 500, durationMs: 1_000 },
  } as const;

  it("announces and draws the same phrase for an ordinary block", () => {
    expect(blockReason({ kind: "noRoom" })).toBe("no room");
    expect(drawnBlockReason({ kind: "noRoom" })).toBe("no room");
    expect(blockReason({ kind: "taken" })).toBe("in use");
    expect(drawnBlockReason({ kind: "taken" })).toBe("in use");
  });

  it("draws nothing for a pull in progress, and still announces it", () => {
    expect(drawnBlockReason(WORKING)).toBeNull();
    expect(blockReason(WORKING)).toBe("working");
  });

  it("says nothing either way on the respawn point you are anchored to", () => {
    expect(drawnBlockReason({ kind: "here" })).toBeNull();
    expect(blockReason({ kind: "here" })).toBeNull();
  });
});
