/**
 * The game view: a fixed square of world, the same on every device.
 *
 * Everyone sees exactly {@link VIEW_CELLS} cells across, whatever they are
 * playing on. A wider monitor buys bigger pixels, never more world — which is
 * the point, since seeing further than the person you are standing next to is
 * an advantage the window size should not hand out.
 *
 * Tibia frames it the same way, on a slightly tighter square (15 tiles wide,
 * player in the centre one, three more shipped either side that are never
 * drawn). The off-screen ring costs us nothing to keep: chunk geometry is built
 * for the whole map and culled per chunk, and the lighting window is already
 * grown past the view, so a step never reveals an unbuilt or unlit strip at the
 * edge.
 */
import { CELL_SIZE } from "../lib/types";

/**
 * Cells across the square view. Odd, so the player stands in a true centre
 * cell rather than on the seam between two.
 */
export const VIEW_CELLS = 19;

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
 * Fit the view to a square pane of `cssSize` CSS pixels.
 *
 * The buffer is a whole multiple of the view and the element is then stretched
 * over the pane, so the fit is exact with no letterbox *inside* the square. The
 * stretch is the only fractional step, and `image-rendering: pixelated` keeps
 * it a nearest-neighbour blow-up: some pixels land a device pixel wider than
 * their neighbours, but the unevenness is static rather than crawling with the
 * camera, which is what a fractional render scale would give.
 */
export function fitViewport(cssSize: number): ViewportFit {
  const usable = Math.max(1, Math.floor(cssSize));
  // At least 1: a pane narrower than the view still gets a whole buffer, shrunk
  // by the stretch rather than rendered at a fraction of a pixel.
  const renderScale = Math.max(1, Math.floor(usable / VIEW_PX));
  return {
    bufferPx: VIEW_PX * renderScale,
    renderScale,
    cssScale: usable / VIEW_PX,
  };
}
