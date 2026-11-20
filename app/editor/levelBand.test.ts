import { describe, expect, it } from "vitest";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { drawnLevelRange, levelVisibility } from "./levelBand";

describe("drawnLevelRange", () => {
  it("holds exactly the levels levelVisibility draws, in every mode", () => {
    for (const current of [MIN_LEVEL, -9, -1, 0, 1, 7, MAX_LEVEL]) {
      for (const showOther of [false, true]) {
        for (const preview of [false, true]) {
          const range = drawnLevelRange(current, showOther, preview);
          for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
            const drawn = levelVisibility(z, current, showOther, preview) !== "hidden";
            const inRange = z >= range.z0 && z <= range.z1;
            expect(inRange, `z=${z} current=${current} other=${showOther} preview=${preview}`).toBe(
              drawn,
            );
          }
        }
      }
    }
  });
});
