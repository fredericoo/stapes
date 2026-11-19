import { describe, expect, it } from "vitest";
import { blockReason, drawnBlockReason, pointerHint } from "../game/interactionOptions";
import { fillElapsedMs } from "./InteractionList";

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

describe("why a blocked row is grey", () => {
  const WORKING = {
    kind: "working",
    extraction: { key: "0:1,0|bush", remainingMs: 500, durationMs: 1_000 },
  } as const;

  it("announces and draws the same phrase for an ordinary block", () => {
    expect(blockReason({ kind: "noRoom" })).toBe("no room");
    expect(drawnBlockReason({ kind: "noRoom" })).toEqual({ text: "no room" });
    expect(blockReason({ kind: "taken" })).toBe("in use");
    expect(drawnBlockReason({ kind: "taken" })).toEqual({ text: "in use" });
  });

  it("draws the rating a reward needs beside a star, and announces it in words", () => {
    expect(drawnBlockReason({ kind: "needs", rating: 10 })).toEqual({ text: "needs", rating: 10 });
    expect(blockReason({ kind: "needs", rating: 10 })).toBe("needs rating 10");
  });

  it("puts the reason where the pointer hint's verb would be", () => {
    const chest = { label: "Open", blocked: null };
    expect(pointerHint(chest)).toEqual({ text: "Open" });
    expect(pointerHint({ ...chest, blocked: { kind: "needs", rating: 10 } })).toEqual({
      text: "Needs",
      rating: 10,
    });
    expect(pointerHint({ ...chest, blocked: { kind: "noRoom" } })).toEqual({ text: "No room" });
  });

  it("draws nothing for a pull in progress, and still announces it", () => {
    expect(drawnBlockReason(WORKING)).toBeNull();
    expect(blockReason(WORKING)).toBe("working");
  });
});
