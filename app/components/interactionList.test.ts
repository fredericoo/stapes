import { describe, expect, it } from "vitest";
import { fillElapsedMs } from "./InteractionList";

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
