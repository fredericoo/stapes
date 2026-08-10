import { describe, expect, it } from "vitest";
import { displayNameFor } from "../game/displayName";
import { labelScreenPosition } from "./textLabels";

/**
 * Where a label lands, without a browser.
 *
 * The drawing is now the browser's job — a webfont in a div, which is the whole
 * point of the change that put it there. What is still ours, and still able to
 * be wrong in a way nobody notices until it looks slightly soft, is the
 * arithmetic that turns a world position into a screen one.
 */

describe("label placement", () => {
  const camera = { x: 100, y: 200 };

  it("measures from the camera's top left", () => {
    expect(labelScreenPosition(100, 200, camera, 1)).toEqual({
      left: 0,
      top: 0,
    });
    expect(labelScreenPosition(110, 220, camera, 1)).toEqual({
      left: 10,
      top: 20,
    });
  });

  it("scales world pixels into CSS pixels", () => {
    expect(labelScreenPosition(110, 220, camera, 4)).toEqual({
      left: 40,
      top: 80,
    });
  });

  /**
   * The font's bricks have to sit on whole pixels — a half pixel of offset is
   * the browser antialiasing a pixel font, which is the one thing 1-bit type
   * cannot absorb. `cssScale` is deliberately fractional (the buffer is
   * stretched to fill the pane), so this is the case that actually happens
   * rather than a defensive one.
   */
  it("lands on whole CSS pixels at every scale", () => {
    for (const cssScale of [1, 4, 5.333333, 6.6875, 0.25]) {
      for (const worldX of [100, 103, 110.5, 87.25, 199.99]) {
        const at = labelScreenPosition(worldX, worldX * 2, camera, cssScale);
        expect(
          Number.isInteger(at.left),
          `left for ${worldX} @ ${cssScale}`,
        ).toBe(true);
        expect(Number.isInteger(at.top), `top for ${worldX} @ ${cssScale}`).toBe(
          true,
        );
      }
    }
  });

  /** A label behind the camera is still placed; the layer clips it, not this. */
  it("places a label outside the view rather than dropping it", () => {
    expect(labelScreenPosition(0, 0, camera, 2)).toEqual({
      left: -200,
      top: -400,
    });
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
    for (const id of ["", "-", "ab", "----------", "z"]) {
      expect(displayNameFor(id)).toMatch(/^[A-Z0-9]{6}$/);
    }
  });
});
