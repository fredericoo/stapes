import { describe, expect, it } from "vitest";
import { fitViewport, VIEW_CELLS, VIEW_PX } from "./viewport";

describe("fitViewport", () => {
  /**
   * The whole point of the fixed view: the pane decides how big the pixels are
   * and nothing else. A player on a large monitor must not see further than one
   * on a phone.
   */
  it("shows the same world at every pane size", () => {
    for (const pane of [200, 375, 900, 1440, 2560]) {
      const fit = fitViewport(pane);
      expect(fit.bufferPx / fit.renderScale).toBe(VIEW_PX);
      expect(VIEW_PX / VIEW_CELLS).toBe(8);
    }
  });

  it("renders on a whole pixel grid", () => {
    for (const pane of [375, 421, 900, 1013]) {
      const fit = fitViewport(pane);
      expect(Number.isInteger(fit.renderScale)).toBe(true);
      expect(fit.bufferPx % VIEW_PX).toBe(0);
    }
  });

  /** The stretch is what fills the pane; it is the only fractional step. */
  it("covers the pane exactly", () => {
    const pane = 1013;
    expect(fitViewport(pane).cssScale * VIEW_PX).toBe(pane);
  });

  /**
   * A pane smaller than the view still gets a whole buffer. Rendering at a
   * fraction of a pixel to fit would trade the shimmer we are avoiding for a
   * gap we do not need.
   */
  it("never renders below one pixel per world pixel", () => {
    const fit = fitViewport(60);
    expect(fit.renderScale).toBe(1);
    expect(fit.bufferPx).toBe(VIEW_PX);
    expect(fit.cssScale).toBeLessThan(1);
  });

  it("survives a pane with no size yet", () => {
    const fit = fitViewport(0);
    expect(fit.renderScale).toBe(1);
    expect(fit.bufferPx).toBe(VIEW_PX);
  });
});
