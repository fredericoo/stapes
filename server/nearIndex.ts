/** How many cells a side each bucket of a {@link NearIndex} covers. */
export const NEAR_BUCKET_CELLS = 16;

/**
 * Numbers filed by a point each, for finding the ones filed near a place.
 *
 * A tick's changes are filed by where they happened, and each client visits
 * only the ones filed within reach of it rather than every change in the
 * world: with a thousand players walking that was about three hundred changes
 * for each of a thousand clients, every tick, to find the thirty or so each
 * was owed.
 *
 * Filled, then sealed, then read; built once per tick. The buckets are a flat
 * grid over the box the points fall in, stored as a compressed sparse row:
 * bucket `b` holds `items[start[b]]` up to `items[start[b + 1]]`.
 */
export class NearIndex {
  private xs: number[] = [];
  private ys: number[] = [];
  private values: number[] = [];
  private minBx = 0;
  private minBy = 0;
  private width = 0;
  private height = 0;
  private start = new Int32Array(1);
  private items = new Int32Array(0);

  /** File `value` at (x, y). A value may be filed at several points. */
  add(x: number, y: number, value: number) {
    this.xs.push(x);
    this.ys.push(y);
    this.values.push(value);
  }

  /** Lay out what was filed for reading. Nothing may be filed after. */
  seal(): this {
    const count = this.values.length;
    if (count === 0) return this;
    let minBx = Infinity;
    let maxBx = -Infinity;
    let minBy = Infinity;
    let maxBy = -Infinity;
    const bucketX = new Int32Array(count);
    const bucketY = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      const bx = Math.floor(this.xs[k]! / NEAR_BUCKET_CELLS);
      const by = Math.floor(this.ys[k]! / NEAR_BUCKET_CELLS);
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
    const items = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      const b = (bucketX[k]! - minBx) * this.height + (bucketY[k]! - minBy);
      items[fill[b]!++] = this.values[k]!;
    }
    this.start = start;
    this.items = items;
    this.xs = [];
    this.ys = [];
    this.values = [];
    return this;
  }

  /**
   * Set `stamp[value] = mark` for every value filed within `reach` cells of
   * (x, y) on both axes — and for some a little further, since whole buckets
   * are read. Returns how many values it marked that were not marked already.
   */
  mark(x: number, y: number, reach: number, stamp: Int32Array, mark: number): number {
    if (this.items.length === 0) return 0;
    const fromBx = Math.max(Math.floor((x - reach) / NEAR_BUCKET_CELLS) - this.minBx, 0);
    const toBx = Math.min(Math.floor((x + reach) / NEAR_BUCKET_CELLS) - this.minBx, this.width - 1);
    const fromBy = Math.max(Math.floor((y - reach) / NEAR_BUCKET_CELLS) - this.minBy, 0);
    const toBy = Math.min(
      Math.floor((y + reach) / NEAR_BUCKET_CELLS) - this.minBy,
      this.height - 1,
    );
    if (fromBx > toBx || fromBy > toBy) return 0;
    const { start, items } = this;
    let marked = 0;
    for (let bx = fromBx; bx <= toBx; bx++) {
      const row = bx * this.height;
      const from = start[row + fromBy]!;
      const to = start[row + toBy + 1]!;
      for (let k = from; k < to; k++) {
        const value = items[k]!;
        if (stamp[value] === mark) continue;
        stamp[value] = mark;
        marked++;
      }
    }
    return marked;
  }
}
