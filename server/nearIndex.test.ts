import { describe, expect, it } from "bun:test";
import { BODY_REACH_ON_LEVEL, withinBodyReachOf } from "../app/net/interest";
import { MAX_LEVEL, MIN_LEVEL } from "../app/lib/types";
import { NEAR_BUCKET_CELLS, NearIndex } from "./nearIndex";

/**
 * A client's cut reads only what the tick filed within its reach, so a value
 * the index fails to mark is a change that client is never sent, and one it
 * marks wrongly is a change it is asked about for nothing. Every case here
 * checks the marked values against `withinBodyReachOf`, point by point.
 */

type Filed = { x: number; y: number; z: number; value: number };

/** Every value filed at a point within a body's reach of (x, y, z). */
function within(filed: readonly Filed[], x: number, y: number, z: number): Set<number> {
  const out = new Set<number>();
  for (const point of filed) {
    if (withinBodyReachOf(x, y, z, point.x, point.y, point.z)) out.add(point.value);
  }
  return out;
}

function build(filed: readonly Filed[]): NearIndex {
  const index = new NearIndex();
  for (const point of filed) index.add(point.x, point.y, point.z, point.value);
  return index.seal();
}

function marked(stamp: Int32Array, mark: number): Set<number> {
  const out = new Set<number>();
  for (let value = 0; value < stamp.length; value++) if (stamp[value] === mark) out.add(value);
  return out;
}

/** A seeded generator, so a failure is the same failure on the next run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function level(random: () => number): number {
  return MIN_LEVEL + Math.floor(random() * (MAX_LEVEL - MIN_LEVEL + 1));
}

describe("what the tick filed within a client's reach", () => {
  it("marks exactly the values filed within reach, wherever they and the client stand", () => {
    const random = seeded(7);
    const values = 300;
    const filed: Filed[] = [];
    for (let k = 0; k < 900; k++) {
      filed.push({
        x: Math.floor(random() * 400) - 200,
        y: Math.floor(random() * 400) - 200,
        z: random() < 0.6 ? 0 : level(random),
        // Some values filed at two points and more, as a cell is filed where its
        // body stands and where it stood.
        value: k % values,
      });
    }
    const index = build(filed);
    const stamp = new Int32Array(values);
    for (let mark = 1; mark <= 500; mark++) {
      const x = Math.floor(random() * 500) - 250;
      const y = Math.floor(random() * 500) - 250;
      const z = random() < 0.6 ? 0 : level(random);
      const count = index.markWithinReach(x, y, z, stamp, mark);
      const found = marked(stamp, mark);
      expect(found).toEqual(within(filed, x, y, z));
      expect(count).toBe(found.size);
    }
  });

  it("marks a value at each corner of reach, on either side of a bucket edge", () => {
    for (const offset of [0, 1, NEAR_BUCKET_CELLS - 1, NEAR_BUCKET_CELLS, 7 * NEAR_BUCKET_CELLS]) {
      for (const dz of [0, 1, MAX_LEVEL - MIN_LEVEL]) {
        const reach = BODY_REACH_ON_LEVEL + dz;
        for (const [dx, dy] of [
          [reach, reach],
          [-reach, reach],
          [reach, -reach],
          [-reach, -reach],
        ] as const) {
          const x = offset;
          const y = -offset;
          const z = MIN_LEVEL;
          const filed = [
            { x: x + dx, y: y + dy, z: z + dz, value: 0 },
            // One step further out, which is out of reach.
            { x: x + dx + Math.sign(dx), y: y + dy, z: z + dz, value: 1 },
          ];
          const stamp = new Int32Array(2);
          build(filed).markWithinReach(x, y, z, stamp, 1);
          expect([...stamp]).toEqual([1, 0]);
        }
      }
    }
  });

  it("marks nothing when nothing was filed, or nothing near", () => {
    const stamp = new Int32Array(4);
    expect(new NearIndex().seal().markWithinReach(0, 0, 0, stamp, 1)).toBe(0);
    const far = build([{ x: 1000, y: 1000, z: 0, value: 3 }]);
    expect(far.markWithinReach(0, 0, 0, stamp, 1)).toBe(0);
    expect(far.markWithinReach(-2000, 1000, 0, stamp, 1)).toBe(0);
    expect(far.markWithinReach(1000, -2000, 0, stamp, 1)).toBe(0);
    expect([...stamp]).toEqual([0, 0, 0, 0]);
  });

  it("does not count a value another point already marked for this client", () => {
    const index = build([
      { x: 0, y: 0, z: 0, value: 0 },
      { x: 1, y: 1, z: 0, value: 0 },
      { x: 2, y: 2, z: 0, value: 1 },
    ]);
    const stamp = new Int32Array(2);
    expect(index.markWithinReach(0, 0, 0, stamp, 5)).toBe(2);
    // Again for the same client: nothing new.
    expect(index.markWithinReach(0, 0, 0, stamp, 5)).toBe(0);
    // A new client marks afresh.
    expect(index.markWithinReach(0, 0, 0, stamp, 6)).toBe(2);
  });
});
