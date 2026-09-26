import { parseCoordKey } from "../lib/types";

/**
 * The shader samples this texture for every fragment on the level, and a
 * texture clamps at its edge rather than reading zero past it, so without a
 * ring of zeros the outermost cut row would smear across the floor beyond it.
 */
const APRON_CELLS = 1;

export type CutMask = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Uint8Array;
};

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
