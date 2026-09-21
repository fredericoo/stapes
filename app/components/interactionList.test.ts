import { describe, expect, it } from "vitest";
import { blockReason, drawnBlockReason, fillElapsedMs } from "./InteractionList";

/**
 * The arithmetic behind the bar across a row with a wait on it — a pull being
 * made, or the time until this fight's next blow.
 *
 * Pure precisely so it can be asserted here rather than by screenshotting a
 * browser, on `StatusStrip`'s terms: the rendering is not under test, the
 * number that decides it is. And it is the number that decides *everything*
 * about the fill — a negative animation delay is the whole mechanism, so a
 * value out of range is a bar drawn outside the button it belongs to.
 */

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

  /**
   * The two numbers arrive separately — the server sends them and the client
   * winds one of them down against its own frame clock — so nothing forces them
   * into a ratio. Both directions are clamped rather than trusted.
   */
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

/**
 * The same arithmetic on the fight row, where what it draws is the wait before
 * the next blow.
 *
 * Asserted separately from the pull above because the interesting case is one a
 * pull never poses: a fight *opens* half spent. The windup is half an interval
 * and the bar is measured against a whole one, so the first blow of a fight is
 * waited out on a bar that arrives half full and fills the rest of the way.
 * @see `../game/GameSession`'s `ActorRuntime.nextBlow`
 */
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

  /** And empty again on the tick the blow goes out, which re-arms the cooldown. */
  it("is nothing when a blow has just been thrown", () => {
    expect(fillElapsedMs(wait(INTERVAL_MS))).toBe(0);
  });
});

/**
 * Which of a blocked row's two voices says why.
 *
 * A row that cannot be pressed has to say so twice — once in the column, where
 * there are eleven pixels of type, and once in its `aria-label`, where a screen
 * reader cannot see the grey. Usually both say the same phrase, and the two
 * cases where they do not are the whole reason these are separate functions.
 */
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

  /**
   * The bar behind the verb says it better than the word does and in none of
   * the width — but a bar is invisible to a screen reader, so the announcement
   * keeps the word.
   */
  it("draws nothing for a pull in progress, and still announces it", () => {
    expect(drawnBlockReason(WORKING)).toBeNull();
    expect(blockReason(WORKING)).toBe("working");
  });

  /**
   * The opposite case: this is the one block that replaced the *verb* rather
   * than annotating it, so the row already reads "You respawn here". Saying it
   * again in either voice is the same fact twice.
   */
  it("says nothing either way on the respawn point you are anchored to", () => {
    expect(drawnBlockReason({ kind: "here" })).toBeNull();
    expect(blockReason({ kind: "here" })).toBeNull();
  });
});
