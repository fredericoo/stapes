import { parseCoordKey } from "../lib/types";

/**
 * One level's roof-cut, laid out as the bytes a mask texture is uploaded from.
 *
 * Kept free of THREE so the bounding box, apron and row-major index can be
 * asserted in a test: a wrong index cuts a hole in the building next door and
 * shows up only on screen.
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
 * Sized to the cut's bounding box, not to the camera: a few hundred bytes
 * whatever the viewport or world measures, and rewritten only when the cut
 * changes rather than when the camera moves.
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
