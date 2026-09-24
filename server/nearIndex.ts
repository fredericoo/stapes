import { BODY_REACH_CELLS, withinBodyReachOf } from "../app/net/interest";

/** How many cells a side each bucket of a {@link NearIndex} covers. */
export const NEAR_BUCKET_CELLS = 16;

/**
 * Numbers filed by a point each, for finding the ones filed within a body's
 * reach of a place.
 *
 * A tick's changes are filed by where they happened, and each client visits
 * only the ones filed within its reach rather than every change in the world:
 * with a thousand players walking that was about three hundred changes for
 * each of a thousand clients, every tick, to find the thirty or so each was
 * owed.
 *
 * Filled, then sealed, then read; built once per tick. The buckets are a flat
 * grid over the box the points fall in, stored as a compressed sparse row:
 * bucket `b` holds entries `start[b]` up to `start[b + 1]`, each a point and
 * the value filed at it.
 */
export class NearIndex {
  private filed: number[] = [];
  private minBx = 0;
  private minBy = 0;
  private width = 0;
  private height = 0;
  private start = new Int32Array(1);
  private xs = new Int32Array(0);
  private ys = new Int32Array(0);
  private zs = new Int32Array(0);
  private values = new Int32Array(0);

  /** File `value` at (x, y, z). A value may be filed at several points. */
  add(x: number, y: number, z: number, value: number) {
    this.filed.push(x, y, z, value);
  }

  /** Lay out what was filed for reading. Nothing may be filed after. */
  seal(): this {
    const filed = this.filed;
    const count = filed.length / 4;
    this.filed = [];
    if (count === 0) return this;
    let minBx = Infinity;
    let maxBx = -Infinity;
    let minBy = Infinity;
    let maxBy = -Infinity;
    const bucketX = new Int32Array(count);
    const bucketY = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      const bx = Math.floor(filed[k * 4]! / NEAR_BUCKET_CELLS);
      const by = Math.floor(filed[k * 4 + 1]! / NEAR_BUCKET_CELLS);
      bucketX[k] = bx;
      bucketY[k] = by;
      if (bx < minBx) minBx = bx;
      if (bx > maxBx) maxBx = bx;
      if (by < minBy) minBy = by;
      if (by > maxBy) maxBy = by;
    }
    this.minBx = minBx;
    this.minBy = minBy;
    this.width = maxBx - minBx + 1;
    this.height = maxBy - minBy + 1;
    const start = new Int32Array(this.width * this.height + 1);
    for (let k = 0; k < count; k++) {
      start[(bucketX[k]! - minBx) * this.height + (bucketY[k]! - minBy) + 1]!++;
    }
    for (let b = 1; b < start.length; b++) start[b]! += start[b - 1]!;
    const fill = start.slice(0, start.length - 1);
    this.xs = new Int32Array(count);
    this.ys = new Int32Array(count);
    this.zs = new Int32Array(count);
    this.values = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      const at = fill[(bucketX[k]! - minBx) * this.height + (bucketY[k]! - minBy)]!++;
      this.xs[at] = filed[k * 4]!;
      this.ys[at] = filed[k * 4 + 1]!;
      this.zs[at] = filed[k * 4 + 2]!;
      this.values[at] = filed[k * 4 + 3]!;
    }
    this.start = start;
    return this;
  }

  /**
   * Set `stamp[value] = mark` for every value filed at a point a body at
   * (x, y, z) can see — `withinBodyReachOf`, exactly. Returns how many values
   * it marked that were not marked already.
   */
  markWithinReach(x: number, y: number, z: number, stamp: Int32Array, mark: number): number {
    if (this.values.length === 0) return 0;
    const reach = BODY_REACH_CELLS;
    const fromBx = Math.max(Math.floor((x - reach) / NEAR_BUCKET_CELLS) - this.minBx, 0);
    const toBx = Math.min(Math.floor((x + reach) / NEAR_BUCKET_CELLS) - this.minBx, this.width - 1);
    const fromBy = Math.max(Math.floor((y - reach) / NEAR_BUCKET_CELLS) - this.minBy, 0);
    const toBy = Math.min(
      Math.floor((y + reach) / NEAR_BUCKET_CELLS) - this.minBy,
      this.height - 1,
    );
    if (fromBx > toBx || fromBy > toBy) return 0;
    const { start, xs, ys, zs, values } = this;
    let marked = 0;
    for (let bx = fromBx; bx <= toBx; bx++) {
      const row = bx * this.height;
      const to = start[row + toBy + 1]!;
      for (let k = start[row + fromBy]!; k < to; k++) {
        const value = values[k]!;
        if (stamp[value] === mark) continue;
        if (!withinBodyReachOf(x, y, z, xs[k]!, ys[k]!, zs[k]!)) continue;
        stamp[value] = mark;
        marked++;
      }
    }
    return marked;
  }
}
