import { describe, expect, it } from "vitest";
import { continuesDoubleTap } from "./useNoZoom";

/**
 * When a finger landing is the second half of a double-tap.
 *
 * The rule has to be tight in both directions. Too loose and a flick started
 * just after a tap is refused its scroll, since cancelling the gesture cancels
 * the whole touch's default action. Too tight and iOS's magnifier gets away,
 * which is the gesture this exists to catch.
 */

const WITHIN_MS = 300;
const SLOP_PX = 30;
const AT = { atMs: 1_000, x: 50, y: 50 };

const landing = (atMs: number, x: number, y: number) => ({ atMs, x, y });

describe("continuesDoubleTap", () => {
  it("catches a second tap in the same place, straight away", () => {
    expect(
      continuesDoubleTap(AT, landing(AT.atMs + 50, AT.x, AT.y), WITHIN_MS, SLOP_PX),
    ).toBe(true);
  });

  it("lets a slow second tap through — that is two taps, not a gesture", () => {
    expect(
      continuesDoubleTap(
        AT,
        landing(AT.atMs + WITHIN_MS, AT.x, AT.y),
        WITHIN_MS,
        SLOP_PX,
      ),
    ).toBe(false);
  });

  it("lets a second tap somewhere else through", () => {
    expect(
      continuesDoubleTap(
        AT,
        landing(AT.atMs + 50, AT.x + SLOP_PX, AT.y),
        WITHIN_MS,
        SLOP_PX,
      ),
    ).toBe(false);
  });

  it("allows a thumb the wobble it never lands twice without", () => {
    expect(
      continuesDoubleTap(
        AT,
        landing(AT.atMs + 50, AT.x + SLOP_PX - 1, AT.y),
        WITHIN_MS,
        SLOP_PX,
      ),
    ).toBe(true);
  });

  it("lets the very first touch of all through", () => {
    expect(
      continuesDoubleTap(null, landing(AT.atMs, AT.x, AT.y), WITHIN_MS, SLOP_PX),
    ).toBe(false);
  });
});
