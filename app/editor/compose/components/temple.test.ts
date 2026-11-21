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
});
