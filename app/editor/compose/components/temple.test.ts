import { describe, expect, it } from "vitest";
import { getStack, stackHeight } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL } from "../../../lib/types";
import type { BuildResult } from "../build";
import type { MapNode } from "../doc";
import { buildTree, frame, land, node, sketch, tilesById, walks } from "../testTree";
import { TEMPLE_BASES } from "./temple";

const SIZE = { w: 30, h: 30 };
const SITE = frame(8, 8, 11, 15);
const STREET = { x: 2, y: 2 };
const MIDDLE = { x: 13, y: 15 };

const temple = (props: Record<string, unknown> = {}, rest: Partial<MapNode> = {}) =>
  node("temple", props, { frame: SITE, ...rest });

const isPillar = (tileId: string) => tileId.startsWith("marble-pillar");

/** The cells a pillar stands on, whichever level its foot is on. */
function pillars(built: BuildResult): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SIZE.h; y++) {
    for (let x = 0; x < SIZE.w; x++) {
      const foot = [0, 1].some((z) => getStack(built.map, x, y, z).some((p) => isPillar(p.tileId)));
      if (foot) out.push({ x, y });
    }
  }
  return out;
}

/** The lengths of the runs of cells without a pillar between the pillars of one row or column. */
function gaps(along: number[]): number[] {
  const sorted = [...along].sort((a, b) => a - b);
  return sorted.slice(1).map((at, i) => at - sorted[i]! - 1);
}

describe("temple", () => {
  it.each(TEMPLE_BASES)("is walked into from the street and out again on a base of %s", (base) => {
    const built = buildTree(land(SIZE, [temple({ base })]));
    expect(walks(built, STREET, MIDDLE), sketch(built)).toBe(true);
    expect(walks(built, MIDDLE, STREET), sketch(built)).toBe(true);
  });

  it("is climbed onto its podium by the step round it and by nothing else", () => {
    const stepless = buildTree(land(SIZE, [temple(), node("clear", { remove: ["marble-block"] })]));
    expect(walks(stepless, STREET, { x: 2, y: 27 }), sketch(stepless)).toBe(true);
    expect(walks(stepless, STREET, MIDDLE), sketch(stepless)).toBe(false);
  });

  it.each([
    { gap: 1, w: 11, h: 15 },
    { gap: 1, w: 12, h: 14 },
    { gap: 2, w: 11, h: 15 },
    { gap: 2, w: 13, h: 12 },
  ])(
    "stands a pillar on every corner and every $gap cells between in a $w by $h frame",
    ({ gap, w, h }) => {
      const built = buildTree(land(SIZE, [temple({ gap }, { frame: frame(8, 8, w, h) })]));
      const cells = pillars(built);
      const xs = cells.map((c) => c.x);
      const ys = cells.map((c) => c.y);
      const west = Math.min(...xs);
      const east = Math.max(...xs);
      const north = Math.min(...ys);
      const south = Math.max(...ys);
      const side = (keep: (c: { x: number; y: number }) => boolean, axis: "x" | "y") =>
        gaps(cells.filter(keep).map((c) => c[axis]));
      const every = [
        ...side((c) => c.y === north, "x"),
        ...side((c) => c.y === south, "x"),
        ...side((c) => c.x === west, "y"),
        ...side((c) => c.x === east, "y"),
      ];
      expect(new Set(every), sketch(built)).toEqual(new Set([gap]));
      const inside = cells.filter((c) => c.x > west && c.x < east && c.y > north && c.y < south);
      expect(inside, sketch(built)).toEqual([]);
    },
  );

  it.each(TEMPLE_BASES.flatMap((base) => [1, 2, 4].map((height) => ({ base, height }))))(
    "carries its roof on pillars $height levels tall with no gap under it, on a base of $base",
    ({ base, height }) => {
      const built = buildTree(land(SIZE, [temple({ base, height })]));
      const floor = base === "podium" ? 1 : 0;
      for (const { x, y } of pillars(built)) {
        for (let z = floor; z < floor + height; z++) {
          const stack = getStack(built.map, x, y, z);
          expect(stackHeight(stack, tilesById), `${x},${y} z${z}`).toBe(HEIGHT_PER_LEVEL);
        }
        const over = getStack(built.map, x, y, floor + height).map((p) => p.tileId);
        expect(over, `${x},${y}`).toEqual(["marble-block"]);
      }
      expect(getStack(built.map, MIDDLE.x, MIDDLE.y, floor + height)).toHaveLength(1);
    },
  );

  it("stands a tile placed inside it afterwards on the podium's floor", () => {
    const built = buildTree(
      land(SIZE, [
        temple(
          {},
          {
            children: [
              node("tile", {
                tile: "stone-forge",
                at: { x: 0, y: 0, pinX: "center", pinY: "center" },
              }),
            ],
          },
        ),
      ]),
    );
    const stack = getStack(built.map, MIDDLE.x, MIDDLE.y, 1).map((p) => p.tileId);
    expect(stack, sketch(built)).toEqual(["flagstone-floor", "stone-forge"]);
  });

  it("is refused on a frame too small for one bay each way", () => {
    const built = buildTree(land(SIZE, [temple({}, { frame: frame(8, 8, 4, 9) })]), {
      problems: "returned",
    });
    expect(built.problems.map((p) => p.reason)).toEqual([
      "This frame is too small for a temple. Make it at least 5 cells each way.",
    ]);
  });

  it("is refused across the edge of a hill", () => {
    const built = buildTree(
      land(SIZE, [
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(0, 0, 14, 30) }),
        temple(),
      ]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.key)).toEqual(["temple-1"]);
  });

  describe("in ruins", () => {
    const RUINS = [0, 20, 40, 60, 80, 100];
    const SEEDS = [1, 2, 3, 4, 5];
    const ROOF_LEVEL = 4;
    const atRuin = (ruin: number, seed: number) =>
      buildTree(land(SIZE, [temple({ ruin }, { seed })]));

    /** The cells whose pillar stands whole, to the level the roof sits on. */
    const whole = (built: BuildResult) =>
      new Set(
        pillars(built)
          .filter(({ x, y }) =>
            getStack(built.map, x, y, ROOF_LEVEL - 1).some(
              (p) => p.tileId === "marble-pillar-top" || p.tileId === "marble-pillar-top-cracked",
            ),
          )
          .map(({ x, y }) => `${x},${y}`),
      );

    const roof = (built: BuildResult) => {
      const cells = new Set<string>();
      for (let y = 0; y < SIZE.h; y++) {
        for (let x = 0; x < SIZE.w; x++) {
          if (getStack(built.map, x, y, ROOF_LEVEL).some((p) => p.tileId === "marble-block")) {
            cells.add(`${x},${y}`);
          }
        }
      }
      return cells;
    };

    it.each(RUINS)("is still walked into and out of at %i% ruin", (ruin) => {
      for (const seed of SEEDS) {
        const built = atRuin(ruin, seed);
        expect(walks(built, STREET, MIDDLE), `seed ${seed}\n${sketch(built)}`).toBe(true);
        expect(walks(built, MIDDLE, STREET), `seed ${seed}\n${sketch(built)}`).toBe(true);
      }
    });

    it.each(RUINS)("keeps no slab of roof that no whole pillar holds up at %i% ruin", (ruin) => {
      for (const seed of SEEDS) {
        const built = atRuin(ruin, seed);
        const kept = roof(built);
        const held = [...whole(built)].filter((key) => kept.has(key));
        const joined = new Set(held);
        for (const key of held) {
          const [x, y] = key.split(",").map(Number) as [number, number];
          for (const next of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
            if (kept.has(next) && !joined.has(next)) {
              joined.add(next);
              held.push(next);
            }
          }
        }
        expect(
          [...kept].filter((key) => !joined.has(key)),
          `seed ${seed}`,
        ).toEqual([]);
      }
    });

    it("loses pillars and roof only as it is ruined further", () => {
      for (const seed of SEEDS) {
        const builds = RUINS.map((ruin) => atRuin(ruin, seed));
        for (let i = 1; i < builds.length; i++) {
          const before = builds[i - 1]!;
          const after = builds[i]!;
          expect(
            [...whole(after)].filter((key) => !whole(before).has(key)),
            `seed ${seed}`,
          ).toEqual([]);
          expect(
            [...roof(after)].filter((key) => !roof(before).has(key)),
            `seed ${seed}`,
          ).toEqual([]);
        }
      }
    });

    it("stands whole with its full roof at no ruin and keeps less than half of either when fully ruined", () => {
      for (const seed of SEEDS) {
        const intact = atRuin(0, seed);
        const ruined = atRuin(100, seed);
        expect(whole(intact).size).toBe(pillars(intact).length);
        expect(whole(ruined).size).toBeLessThan(pillars(intact).length / 2);
        expect(roof(ruined).size).toBeLessThan(roof(intact).size / 2);
      }
    });
  });
});
