import { describe, expect, it } from "vitest";
import { directionAt } from "./DirectionPad";

const FAR = 100;
const DEAD_ZONE = 8;

describe("directionAt", () => {
  it("reads the four cardinals", () => {
    expect(directionAt(0, -FAR)).toBe("n");
    expect(directionAt(0, FAR)).toBe("s");
    expect(directionAt(FAR, 0)).toBe("e");
    expect(directionAt(-FAR, 0)).toBe("w");
  });

  it("claims the corners outside the diamond", () => {
    expect(directionAt(FAR, -FAR - 1)).toBe("n");
    expect(directionAt(FAR + 1, -FAR)).toBe("e");
    expect(directionAt(-FAR - 1, FAR)).toBe("w");
    expect(directionAt(FAR, FAR + 1)).toBe("s");
  });

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
