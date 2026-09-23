import { describe, expect, it } from "bun:test";
import { NEAR_BUCKET_CELLS, NearIndex } from "./nearIndex";

/**
 * A client's cut reads only what the tick filed near it, so a value the index
 * fails to mark is a change that client is never sent. Every case here checks
 * that a query marks every value filed within reach — the index is allowed to
 * mark more, never fewer.
 */

type Filed = { x: number; y: number; value: number };

/** Every value filed within `reach` of (x, y) on both axes. */
function within(filed: readonly Filed[], x: number, y: number, reach: number): Set<number> {
  const out = new Set<number>();
  for (const point of filed) {
    if (Math.abs(point.x - x) <= reach && Math.abs(point.y - y) <= reach) out.add(point.value);
  }
  return out;
}

function build(filed: readonly Filed[]): NearIndex {
  const index = new NearIndex();
  for (const point of filed) index.add(point.x, point.y, point.value);
  return index.seal();
}

/** A seeded generator, so a failure is the same failure on the next run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("what the tick filed near a client", () => {
  it("marks every value filed within reach, wherever it and the client stand", () => {
    const random = seeded(7);
    const values = 300;
    const filed: Filed[] = [];
    for (let k = 0; k < 600; k++) {
      filed.push({
        x: Math.floor(random() * 400) - 200,
        y: Math.floor(random() * 400) - 200,
        // Some values filed at two points, as a cell is where its body stands and stood.
        value: k % values,
      });
    }
    const index = build(filed);
    const stamp = new Int32Array(values);
    let mark = 0;
    for (let q = 0; q < 500; q++) {
      const x = Math.floor(random() * 500) - 250;
      const y = Math.floor(random() * 500) - 250;
      const reach = Math.floor(random() * 60);
      mark++;
      const marked = index.mark(x, y, reach, stamp, mark);
      const found = new Set<number>();
      for (let value = 0; value < values; value++) if (stamp[value] === mark) found.add(value);
      for (const value of within(filed, x, y, reach)) expect(found.has(value)).toBe(true);
      expect(marked).toBe(found.size);
    }
  });

  it("marks a value at each corner of reach, on either side of a bucket edge", () => {
    const reach = 49;
    for (const offset of [0, 1, NEAR_BUCKET_CELLS - 1, NEAR_BUCKET_CELLS, 7 * NEAR_BUCKET_CELLS]) {
      for (const [dx, dy] of [
        [reach, reach],
        [-reach, reach],
        [reach, -reach],
        [-reach, -reach],
      ] as const) {
        const x = offset;
        const y = -offset;
        const filed = [
          { x: x + dx, y: y + dy, value: 0 },
          // One just out of reach, so the index is not simply marking everything.
          { x: x + dx + Math.sign(dx) * 200, y: y + dy, value: 1 },
        ];
        const stamp = new Int32Array(2);
        build(filed).mark(x, y, reach, stamp, 1);
        expect(stamp[0]).toBe(1);
        expect(stamp[1]).toBe(0);
      }
    }
  });

  it("marks nothing when nothing was filed, or nothing near", () => {
    const stamp = new Int32Array(4);
    expect(new NearIndex().seal().mark(0, 0, 49, stamp, 1)).toBe(0);
    const far = build([{ x: 1000, y: 1000, value: 3 }]);
    expect(far.mark(0, 0, 49, stamp, 1)).toBe(0);
    expect(far.mark(-2000, 1000, 49, stamp, 1)).toBe(0);
    expect(far.mark(1000, -2000, 49, stamp, 1)).toBe(0);
    expect([...stamp]).toEqual([0, 0, 0, 0]);
  });

  it("does not count a value another point already marked for this client", () => {
    const index = build([
      { x: 0, y: 0, value: 0 },
      { x: 1, y: 1, value: 0 },
      { x: 2, y: 2, value: 1 },
    ]);
    const stamp = new Int32Array(2);
    expect(index.mark(0, 0, 10, stamp, 5)).toBe(2);
    // Again for the same client: nothing new.
    expect(index.mark(0, 0, 10, stamp, 5)).toBe(0);
    // A new client marks afresh.
    expect(index.mark(0, 0, 10, stamp, 6)).toBe(2);
  });
});
