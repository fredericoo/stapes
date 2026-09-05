import { describe, expect, it } from "vitest";
import { extractionElapsedMs } from "./InteractionList";

/**
 * The arithmetic behind the bar across a row whose pull is being made.
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
    expect(extractionElapsedMs(pull(5_000))).toBe(0);
  });

  it("is the whole duration once it has finished", () => {
    expect(extractionElapsedMs(pull(0))).toBe(5_000);
  });

  it("is the difference in between", () => {
    expect(extractionElapsedMs(pull(1_500))).toBe(3_500);
  });

  /**
   * The two numbers arrive separately — the server sends them and the client
   * winds one of them down against its own frame clock — so nothing forces them
   * into a ratio. Both directions are clamped rather than trusted.
   */
  it("clamps a remainder that overshoots its own duration", () => {
    expect(extractionElapsedMs(pull(9_000))).toBe(0);
  });

  it("clamps a remainder that has gone negative", () => {
    expect(extractionElapsedMs(pull(-2_000))).toBe(5_000);
  });

  it("is nothing for a pull with no duration at all", () => {
    expect(extractionElapsedMs(pull(0, 0))).toBe(0);
  });
});
