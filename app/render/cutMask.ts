import { parseCoordKey } from "../lib/types";

/**
 * One level's roof-cut, laid out as the bytes a mask texture is uploaded from.
 *
 * Separated from `./WorldRenderer` for the reason `./tileEmitters` is: what is
 * decided here is arithmetic — a bounding box, an apron, a row-major index —
 * and arithmetic can be asserted in a test rather than eyeballed against a
 * canvas. Getting the index wrong does not fail loudly; it cuts a hole in the
 * building next door, which is a thing you only find by walking past it.
 *
 * Nothing in here knows what THREE is.
 */

/**
 * Cells of transparent border on every side of the cut's bounding box.
 *
 * The shader samples this texture for *every* fragment on the level, including
 * the overwhelming majority whose cell is nowhere near the cut, and a texture
 * clamps at its edge rather than reading zero past it. Without a ring of zeros
 * the outermost cut row would smear across the whole floor beyond it.
 */
const APRON_CELLS = 1;

/** A level's cut as a texture: where it starts, how big it is, and its bytes. */
export type CutMask = {
  /** Cell coordinate of the first texel. */
  x0: number;
  y0: number;
  /** Size in cells, which is also the size in texels. */
  w: number;
  h: number;
  /** Row-major, one byte per cell: 255 where the cell is cut, 0 elsewhere. */
  data: Uint8Array;
};

/**
 * Lay out one level's cut cells, or null when the level has none.
 *
 * **Sized to the cut, not to the camera.** A lifted roof is tens of cells
 * across wherever the viewer happens to be standing, so a mask sized to its own
 * bounding box is a few hundred bytes whatever the viewport is doing and
 * whatever the world measures. It also means the mask does not have to be
 * rewritten when the camera slides — only when the cut itself changes.
 *
 * @param cells cut cells on one level, keyed by {@link coordKey}.
 */
export function cutMaskFor(cells: ReadonlySet<string> | undefined): CutMask | null {
  if (!cells || cells.size === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of cells) {
    const { x, y } = parseCoordKey(key);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const x0 = minX - APRON_CELLS;
  const y0 = minY - APRON_CELLS;
  const w = maxX - minX + 1 + APRON_CELLS * 2;
  const h = maxY - minY + 1 + APRON_CELLS * 2;

  const data = new Uint8Array(w * h);
  for (const key of cells) {
    const { x, y } = parseCoordKey(key);
    data[(y - y0) * w + (x - x0)] = 255;
  }

  return { x0, y0, w, h, data };
}
