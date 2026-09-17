import { PX_PER_HEIGHT } from "../lib/geometry";
import { HEIGHT_PER_LEVEL } from "../lib/types";

/**
 * Kept whatever the height, so a bar never shares a row of pixels with the
 * sprite it belongs to. One world pixel, which is five or six screen pixels at
 * play zoom — small enough to still read as attached to the head.
 */
const BASE_HEADROOM_PX = 1;

/**
 * How far above a body's head its name and health bar hang, in world pixels.
 *
 * The label anchors on the tile's declared height, but a sprite is authored to
 * a cell box and often fills it: the cat and the player are the same 2×2 art
 * and differ only in declared height, so anchored on height alone the cat's
 * bar lands inside its own drawing. The gap is the shortfall between the
 * tile's height and a full level, floored at zero because anything taller is
 * drawn from a bigger sprite rect the anchor already accounts for.
 *
 * In world pixels because the drawing scales with the zoom and the label does
 * not.
 */
export function labelHeadroomPx(height: number): number {
  const shortfallUnits = Math.max(0, HEIGHT_PER_LEVEL - height);
  return BASE_HEADROOM_PX + shortfallUnits * PX_PER_HEIGHT;
}
