import { describe, expect, it } from "vitest";
import { directionAt } from "./DirectionPad";

/**
 * Where a thumb has to land to mean each direction.
 *
 * The pad is four quadrants of a diamond rather than four buttons precisely so
 * that there is nowhere to miss, so the interesting cases are the awkward ones:
 * the diagonals between quadrants, the middle, and the corners well outside the
 * drawn shape.
 */

const FAR = 100;
const DEAD_ZONE = 16;

describe("directionAt", () => {
  it("reads the four cardinals", () => {
    expect(directionAt(0, -FAR)).toBe("n");
    expect(directionAt(0, FAR)).toBe("s");
    expect(directionAt(FAR, 0)).toBe("e");
    expect(directionAt(-FAR, 0)).toBe("w");
  });

  /** Nowhere in the pad is dead, so a sloppy tap still goes somewhere sane. */
  it("claims the corners outside the diamond", () => {
    // Just past the diagonal, well beyond the drawn shape.
    expect(directionAt(FAR, -FAR - 1)).toBe("n");
    expect(directionAt(FAR + 1, -FAR)).toBe("e");
    expect(directionAt(-FAR - 1, FAR)).toBe("w");
    expect(directionAt(FAR, FAR + 1)).toBe("s");
  });

  /** Exactly on a diagonal it has to pick one; it must not pick nothing. */
  it("resolves the diagonals", () => {
    for (const [dx, dy] of [
      [FAR, FAR],
      [FAR, -FAR],
      [-FAR, FAR],
      [-FAR, -FAR],
    ]) {
      expect(directionAt(dx!, dy!)).not.toBeNull();
    }
  });

  it("ignores a thumb resting in the middle", () => {
    expect(directionAt(0, 0)).toBeNull();
    expect(directionAt(DEAD_ZONE - 1, 0)).toBeNull();
    expect(directionAt(0, -(DEAD_ZONE - 1))).toBeNull();
  });

  it("steers as soon as the thumb clears the dead zone", () => {
    expect(directionAt(0, -DEAD_ZONE)).toBe("n");
    expect(directionAt(DEAD_ZONE, 0)).toBe("e");
  });
});
