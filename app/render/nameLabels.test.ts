import { describe, expect, it } from "vitest";
import { displayNameFor } from "../game/displayName";
import { PIXEL_TEXT_LINE_PX } from "./pixelText";
import { labelRect } from "./nameLabels";

/**
 * Where a name lands, without a GPU.
 *
 * The drawing is three.js and the rasterising is a canvas, but the part that
 * can be wrong in a way nobody notices until it looks slightly off — landing
 * between pixels — is arithmetic, and stays testable.
 */

describe("label placement", () => {
  it("centres the text on the anchor", () => {
    const rect = labelRect(100, 50, 36);
    expect(rect.x + rect.w / 2).toBe(100);
    expect(rect.w).toBe(36);
    expect(rect.h).toBe(PIXEL_TEXT_LINE_PX);
  });

  it("sits clear above the anchor, never on it", () => {
    const rect = labelRect(0, 0, 36);
    expect(rect.y + rect.h).toBeLessThan(0);
  });

  /**
   * A texel has to cover exactly one world pixel. Half a pixel of offset is a
   * blurred smear across two columns — the one thing 1-bit text cannot absorb.
   */
  it("lands on whole pixels whatever the anchor and width", () => {
    for (const anchorX of [0, 3, 10.5, -7.25, 99.99]) {
      for (const width of [1, 6, 35, 36]) {
        const rect = labelRect(anchorX, anchorX / 2, width);
        expect(Number.isInteger(rect.x), `x for ${anchorX}/${width}`).toBe(true);
        expect(Number.isInteger(rect.y), `y for ${anchorX}/${width}`).toBe(true);
      }
    }
  });
});

describe("display names", () => {
  const uuid = "3f9ac1d2-55b7-4a0e-9c31-8a2b6f0e1d44";

  it("shortens a uuid to something that fits the view", () => {
    expect(displayNameFor(uuid)).toBe("3F9AC1");
  });

  it("gives the same actor the same name every time", () => {
    expect(displayNameFor(uuid)).toBe(displayNameFor(uuid));
  });

  it("tells two actors apart", () => {
    expect(displayNameFor(uuid)).not.toBe(
      displayNameFor("aa11bb22-55b7-4a0e-9c31-8a2b6f0e1d44"),
    );
  });

  /** Short or punctuation-only ids still have to draw something. */
  it("always produces a fixed-width printable handle", () => {
    for (const id of ["", "-", "ab", "a-b-c", uuid]) {
      const name = displayNameFor(id);
      expect(name).toHaveLength(6);
      expect(name).toMatch(/^[A-Z0-9]{6}$/);
    }
  });
});
