import { describe, expect, it } from "vitest";
import { WADE_RING_FRAMES, wadeRingPixel, wadeRingSidePx } from "./wadeRings";

describe("wadeRingPixel", () => {
  it("draws a ripple in every frame and none in the pixels just outside it", () => {
    for (const radiusPx of [2, 3, 4, 8, 12]) {
      const side = wadeRingSidePx(radiusPx);
      for (let frame = 0; frame < WADE_RING_FRAMES; frame++) {
        let inside = 0;
        for (let y = -1; y <= side; y++) {
          for (let x = -1; x <= side; x++) {
            if (wadeRingPixel(radiusPx, frame, x, y) !== "ripple") continue;
            expect([x, y]).not.toContain(-1);
            expect([x, y]).not.toContain(side);
            inside++;
          }
        }
        expect(inside).toBeGreaterThan(0);
      }
    }
  });
});
