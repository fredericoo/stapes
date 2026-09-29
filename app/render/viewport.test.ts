import { describe, expect, it } from "vitest";
import { fitViewport, VIEW_CELLS, VIEW_PX } from "./viewport";

describe("fitViewport", () => {
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

  it("covers the pane exactly", () => {
    const pane = 1013;
    expect(fitViewport(pane).cssScale * VIEW_PX).toBe(pane);
  });

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

  it("keeps the whole pixel grid at a wider span", () => {
    for (const zoomOut of [2, 3, 8]) {
      const span = VIEW_PX * zoomOut;
      for (const pane of [375, 900, 1013, 2560]) {
        const fit = fitViewport(pane, span);
        expect(Number.isInteger(fit.renderScale)).toBe(true);
        expect(fit.bufferPx % span).toBe(0);
        expect(fit.cssScale * span).toBe(pane);
      }
    }
  });

  it("shows a whole multiple more world than the play square", () => {
    const pane = 900;
    const play = fitViewport(pane);
    const wide = fitViewport(pane, VIEW_PX * 3);
    expect(play.cssScale / wide.cssScale).toBe(3);
  });
});
