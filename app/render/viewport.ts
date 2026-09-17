/**
 * The game view: a fixed square of world, the same on every device.
 *
 * Everyone sees exactly {@link VIEW_CELLS} cells across. A wider monitor buys
 * bigger pixels, never more world, so window size does not hand out an
 * advantage in how far you can see.
 *
 * No off-screen ring is shipped: chunk geometry is built for the whole map and
 * culled per chunk, and the lighting window is grown past the view, so a step
 * never reveals an unbuilt or unlit strip at the edge.
 */
import { CELL_SIZE } from "../lib/types";
import { VIEW_CELLS } from "../lib/view";

// Re-exported so the renderer's callers keep one import for the view, and
// defined in `../lib/view` because the server needs it too — see there.
export { VIEW_CELLS };

/** Side of the view in world pixels — what the camera spans on both axes. */
export const VIEW_PX = VIEW_CELLS * CELL_SIZE;

export type ViewportFit = {
  /** Side of the drawing buffer, in pixels. Always a whole multiple of the view. */
  bufferPx: number;
  /**
   * Buffer pixels per world pixel. Whole, so the art renders on a clean grid
   * and does not shimmer as the camera scrolls.
   */
  renderScale: number;
  /**
   * CSS pixels per world pixel. Fractional, because the buffer is stretched to
   * fill the pane exactly — this is the scale pointer coordinates arrive in.
   */
  cssScale: number;
};

/**
 * Fit a square of world to a square pane of `cssSize` CSS pixels.
 *
 * The buffer is a whole multiple of the span and the element is then stretched
 * over the pane, so there is no letterbox inside the square. The stretch is the
 * only fractional step, and `image-rendering: pixelated` keeps it a
 * nearest-neighbour blow-up: some pixels land a device pixel wider than their
 * neighbours, but the unevenness is static rather than crawling with the
 * camera as a fractional render scale would.
 *
 * `spanPx` is {@link VIEW_PX} in every shipped frame. The debug view
 * (`./debugView`) passes a multiple of it to pull the camera back; passing it
 * here rather than scaling the result afterwards keeps the render scale whole.
 */
export function fitViewport(cssSize: number, spanPx: number = VIEW_PX): ViewportFit {
  const usable = Math.max(1, Math.floor(cssSize));
  const span = Math.max(1, Math.floor(spanPx));
  // At least 1: a pane narrower than the span still gets a whole buffer, shrunk
  // by the stretch rather than rendered at a fraction of a pixel.
  const renderScale = Math.max(1, Math.floor(usable / span));
  return {
    bufferPx: span * renderScale,
    renderScale,
    cssScale: usable / span,
  };
}
