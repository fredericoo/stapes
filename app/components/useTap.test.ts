import { describe, expect, it } from "vitest";
import { completesTap } from "./useTap";

/**
 * When a lift means a press.
 *
 * The rule exists because `click` is not an event a touch screen produces — it
 * is synthesised afterwards, and iOS synthesises none while a second finger is
 * down, which is every moment somebody is walking. Reading the press off the
 * pointer events instead means re-deciding by hand the things a click decided
 * for free: that the gesture started here, that it is this finger's, and that it
 * did not turn into a scroll.
 */

const FINGER = 7;
const OTHER_FINGER = 8;
const AT = { x: 100, y: 100 };
const SLOP = 10;

const pressAt = (pointerId: number) => ({ pointerId, ...AT });
const liftAt = (
  pointerId: number,
  pointerType: string,
  x: number,
  y: number,
) => ({ pointerId, pointerType, x, y });

describe("completesTap", () => {
  it("takes a finger that lifts where it landed", () => {
    expect(
      completesTap(pressAt(FINGER), liftAt(FINGER, "touch", AT.x, AT.y), SLOP),
    ).toBe(true);
  });

  it("allows a thumb the slack it never lifts without", () => {
    expect(
      completesTap(
        pressAt(FINGER),
        liftAt(FINGER, "touch", AT.x + SLOP, AT.y),
        SLOP,
      ),
    ).toBe(true);
  });

  it("refuses a finger that travelled — that was a scroll", () => {
    expect(
      completesTap(
        pressAt(FINGER),
        liftAt(FINGER, "touch", AT.x, AT.y + SLOP + 1),
        SLOP,
      ),
    ).toBe(false);
  });

  it("refuses a mouse, which has a real click of its own", () => {
    expect(
      completesTap(pressAt(FINGER), liftAt(FINGER, "mouse", AT.x, AT.y), SLOP),
    ).toBe(false);
  });

  it("refuses a lift from a press that began somewhere else", () => {
    expect(completesTap(null, liftAt(FINGER, "touch", AT.x, AT.y), SLOP)).toBe(
      false,
    );
  });

  it("refuses one finger releasing another finger's press", () => {
    expect(
      completesTap(
        pressAt(FINGER),
        liftAt(OTHER_FINGER, "touch", AT.x, AT.y),
        SLOP,
      ),
    ).toBe(false);
  });
});
