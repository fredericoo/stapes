import { PX_PER_HEIGHT } from "../lib/geometry";
import { HEIGHT_PER_LEVEL } from "../lib/types";

/**
 * How far above a body's head its name and health bar hang, in world pixels.
 *
 * A name label sits on the point the tile's *declared height* puts its head at,
 * and that point is not the top of the drawing. Height is a gameplay figure —
 * what you can stand on, what you can see over — while the sprite is authored
 * to a cell box and routinely fills it: the cat and the player are the same
 * 2×2 art, and the only difference between them is that one declares one height
 * unit and the other two. Anchored on height alone, the cat's bar therefore
 * lands four world pixels into its own drawing, which is exactly where a health
 * bar must never be.
 *
 * So the gap is the difference between the tile's height and a full level's
 * worth, which is the tallest a single-cell drawing can be — a short tile is
 * lifted by however much art it is likely hiding above its head, and one at
 * full height needs nothing on that account. Anything taller than a level is
 * drawn from a bigger sprite rect, whose extra cells the anchor already
 * accounts for, so the shortfall floors at zero rather than pulling the label
 * back down into the art.
 *
 * Stated in world pixels rather than screen pixels because what is being
 * cleared is the drawing, and the drawing scales with the zoom while the label
 * does not.
 */

/**
 * Kept whatever the height, so a bar never shares a row of pixels with the
 * sprite it belongs to. One world pixel, which is five or six screen pixels at
 * play zoom — small enough to still read as attached to the head.
 */
const BASE_HEADROOM_PX = 1;

export function labelHeadroomPx(height: number): number {
  const shortfallUnits = Math.max(0, HEIGHT_PER_LEVEL - height);
  return BASE_HEADROOM_PX + shortfallUnits * PX_PER_HEIGHT;
}
