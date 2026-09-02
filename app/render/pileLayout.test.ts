import { describe, expect, it } from "vitest";
import {
  MAX_PILE_SPRITES,
  NO_PILE_OFFSET,
  pileDepthNudge,
  pileOffsets,
  pileRings,
} from "./pileLayout";

/**
 * How a heap is laid out inside its cell.
 *
 * The die faces are asserted by shape rather than by coordinate — "the four
 * corners", not "(-3,-3) and three more" — so the spread can be tuned by
 * looking at the game, which is the only way to tune it, without a test having
 * an opinion about the number of pixels.
 */

/** The counts a pile can actually be drawn at. */
const EVERY_COUNT = Array.from({ length: MAX_PILE_SPRITES }, (_, i) => i + 1);

function key(o: { dx: number; dy: number }): string {
  return `${o.dx},${o.dy}`;
}

/** Which of the nine lattice cells an offset sits in: -1, 0 or 1 either way. */
function lattice(o: { dx: number; dy: number }): string {
  return `${Math.sign(o.dx)},${Math.sign(o.dy)}`;
}

describe("a pile of one", () => {
  it("does not move, which is every tile in the world", () => {
    expect(pileOffsets(1)).toEqual([{ dx: 0, dy: 0 }]);
  });

  it("is the shared offset, not a fresh one per cell", () => {
    expect(pileOffsets(1)).toBe(NO_PILE_OFFSET);
    expect(pileOffsets(0)).toBe(NO_PILE_OFFSET);
  });
});

describe("the die faces", () => {
  it("draws two as the diagonal pair", () => {
    expect(pileOffsets(2).map(lattice)).toEqual(["-1,-1", "1,1"]);
  });

  it("draws three as the diagonal through the middle", () => {
    expect(pileOffsets(3).map(lattice)).toEqual(["-1,-1", "0,0", "1,1"]);
  });

  it("draws four as the corners", () => {
    expect(new Set(pileOffsets(4).map(lattice))).toEqual(
      new Set(["-1,-1", "1,-1", "-1,1", "1,1"]),
    );
  });

  it("draws five as the corners and the middle", () => {
    expect(new Set(pileOffsets(5).map(lattice))).toEqual(
      new Set(["-1,-1", "1,-1", "0,0", "-1,1", "1,1"]),
    );
  });

  it("draws six as the two full columns, and nothing in the middle one", () => {
    const columns = pileOffsets(6).map((o) => Math.sign(o.dx));
    expect(columns.filter((c) => c === -1)).toHaveLength(3);
    expect(columns.filter((c) => c === 1)).toHaveLength(3);
    expect(columns).not.toContain(0);
  });

  it("holds every face the same distance apart, so a face reads as a face", () => {
    const reach = (n: number) =>
      Math.max(...pileOffsets(n).map((o) => Math.max(Math.abs(o.dx), Math.abs(o.dy))));
    expect([2, 3, 4, 5, 6].map(reach)).toEqual([2, 3, 4, 5, 6].map(() => reach(2)));
  });
});

describe("past six, where there is no face to copy", () => {
  it("still puts something in the middle", () => {
    for (const n of [7, 9, 12]) {
      expect(pileOffsets(n)).toContainEqual({ dx: 0, dy: 0 });
    }
  });

  it("spreads wider than a die face, because there is more to fit", () => {
    const reach = (n: number) =>
      Math.max(...pileOffsets(n).map((o) => Math.max(Math.abs(o.dx), Math.abs(o.dy))));
    expect(reach(12)).toBeGreaterThan(reach(6));
  });
});

describe("every count it will draw", () => {
  it("draws exactly that many", () => {
    for (const n of EVERY_COUNT) expect(pileOffsets(n)).toHaveLength(n);
  });

  it("never stacks two sprites on one pixel", () => {
    for (const n of EVERY_COUNT) {
      const offsets = pileOffsets(n);
      expect(new Set(offsets.map(key)).size).toBe(offsets.length);
    }
  });

  it("stays on whole pixels, so static art keeps the pixel grid", () => {
    for (const n of EVERY_COUNT) {
      for (const o of pileOffsets(n)) {
        expect(Number.isInteger(o.dx)).toBe(true);
        expect(Number.isInteger(o.dy)).toBe(true);
      }
    }
  });

  it("hands them over back to front, which is the order they are biased in", () => {
    for (const n of EVERY_COUNT) {
      const ys = pileOffsets(n).map((o) => o.dy);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  it("is the same arrangement every time, because nothing here is random", () => {
    for (const n of EVERY_COUNT) {
      expect(pileOffsets(n)).toEqual(pileOffsets(n));
    }
  });

  it("stays centred on the cell rather than drifting to one side", () => {
    for (const n of EVERY_COUNT) {
      const offsets = pileOffsets(n);
      const sum = offsets.reduce(
        (acc, o) => ({ dx: acc.dx + o.dx, dy: acc.dy + o.dy }),
        { dx: 0, dy: 0 },
      );
      // Within one pixel per sprite: a die face is exactly balanced, and the
      // greedy fill past six is balanced to a pixel or two rather than exactly.
      expect(Math.abs(sum.dx)).toBeLessThanOrEqual(offsets.length);
      expect(Math.abs(sum.dy)).toBeLessThanOrEqual(offsets.length);
    }
  });
});

describe("more than it will draw", () => {
  it("draws the most it draws, and no more", () => {
    expect(pileOffsets(MAX_PILE_SPRITES + 1)).toHaveLength(MAX_PILE_SPRITES);
    expect(pileOffsets(99)).toHaveLength(MAX_PILE_SPRITES);
  });

  it("draws the same arrangement for every count past the cap", () => {
    expect(pileOffsets(99)).toEqual(pileOffsets(MAX_PILE_SPRITES));
  });
});

describe("depth inside a heap", () => {
  it("leaves a lone sprite exactly where its placement is", () => {
    expect(pileDepthNudge(0, 1)).toBe(0);
  });

  it("lifts each sprite above the one behind it", () => {
    const nudges = [0, 1, 2, 3].map((i) => pileDepthNudge(i, 4));
    expect(nudges).toEqual([...nudges].sort((a, b) => a - b));
    expect(new Set(nudges).size).toBe(nudges.length);
  });

  it("stays inside one stack index, so the heap does not outrank its neighbours", () => {
    for (const total of EVERY_COUNT) {
      for (let i = 0; i < total; i++) {
        const nudge = pileDepthNudge(i, total);
        expect(nudge).toBeGreaterThanOrEqual(0);
        expect(nudge).toBeLessThan(1);
      }
    }
  });
});

/**
 * What the outline layer draws around a heap.
 *
 * Two separate claims, and the bug each one pins is a different picture. **One
 * ring per sprite, at the offsets the sprites were drawn at** — a single ring
 * round the middle berry of a dozen reads as "that one", where a press takes
 * all of them, and a ring anywhere but where its sprite is puts the chrome and
 * the art in disagreement about where the berries are. **Each ring told where
 * the others are** — without that, every ring lands on a neighbour and a heap
 * three pixels apart fills in solid instead of coming out with one silhouette
 * around the whole of it.
 */
describe("the rings around a heap", () => {
  it("draws one per sprite, wherever that sprite was drawn", () => {
    for (const count of EVERY_COUNT) {
      const rings = pileRings(count);
      expect(rings.map((ring) => ring.at)).toEqual([...pileOffsets(count)]);
    }
  });

  /** Every other sprite of the heap, and never itself. */
  it("tells each ring about the others and not about itself", () => {
    for (const count of EVERY_COUNT) {
      for (const ring of pileRings(count)) {
        expect(ring.peers).toHaveLength(count - 1);
        expect(ring.peers.some((p) => p.dx === 0 && p.dy === 0)).toBe(false);
      }
    }
  });

  /**
   * The shader adds a peer to its own uv to stand in for a sibling, so the
   * vector has to run *from* this sprite *to* that one. A sign error here is
   * the kind that looks almost right: the silhouette closes up on one side of
   * the heap and opens on the other.
   */
  it("gives the vector from this sprite to each of the others", () => {
    const offsets = pileOffsets(5);
    pileRings(5).forEach((ring, i) => {
      const others = offsets.filter((_, j) => j !== i);
      expect(ring.peers).toEqual(
        others.map((other) => ({
          dx: offsets[i]!.dx - other.dx,
          dy: offsets[i]!.dy - other.dy,
        })),
      );
    });
  });

  /** Every tile in the world that is not a heap, paying for none of this. */
  it("gives a lone sprite one ring and no peers at all", () => {
    expect(pileRings(1)).toEqual([{ at: NO_PILE_OFFSET[0], peers: [] }]);
  });

  /** On {@link pileOffsets}' terms: past the cap the picture stops growing. */
  it("stops at the widest heap it draws", () => {
    const capped = pileRings(MAX_PILE_SPRITES + 40);
    expect(capped).toHaveLength(MAX_PILE_SPRITES);
    expect(capped).toBe(pileRings(MAX_PILE_SPRITES));
  });
});
