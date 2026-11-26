import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import {
  brokenTallTrees,
  buildTree,
  cutFootprints,
  frame,
  isle,
  land,
  node,
  sketch,
  stands,
  walks,
} from "../testTree";

const SIZE = { w: 40, h: 28 };
const dunes = (rest: Parameters<typeof node>[2] = {}) =>
  node(
    "scatter",
    { tiles: [{ tile: "sand-dune", weight: 1 }], density: 30, onlyOn: ["sand"] },
    { frame: frame(0, 0, SIZE.w, SIZE.h), ...rest },
  );

describe("scatter", () => {
  it.each([1, 2, 3])("lays every dune whole, on sand and nowhere else, seed %i", (seed) => {
    const built = buildTree(isle(SIZE, [dunes()]), { seed });
    expect(stands(built, "sand-dune").length, sketch(built)).toBeGreaterThan(5);
    expect(cutFootprints(built), sketch(built)).toEqual([]);
    for (let y = 0; y < SIZE.h; y++) {
      for (let x = 0; x < SIZE.w; x++) {
        const ids = getStack(built.map, x, y, 0).map((p) => p.tileId);
        if (ids.includes("sand-dune")) expect(ids, `${x},${y}`).toEqual(["sand", "sand-dune"]);
      }
    }
  });

  it("drops a dune its mask would cut rather than laying half of it", () => {
    const whole = buildTree(isle(SIZE, [dunes()]));
    const hole = node("mask", { shape: "rect", op: "subtract" }, { frame: frame(15, 10, 10, 8) });
    const built = buildTree(isle(SIZE, [dunes({ children: [hole] })]));
    const left = stands(built, "sand-dune").length;
    expect(left, sketch(built)).toBeGreaterThan(0);
    expect(left, sketch(built)).toBeLessThan(stands(whole, "sand-dune").length);
    for (let y = 10; y < 18; y++) {
      for (let x = 15; x < 25; x++) {
        expect(getStack(built.map, x, y, 0).at(-1)?.tileId, `${x},${y}`).toBe("sand");
      }
    }
    expect(cutFootprints(built), sketch(built)).toEqual([]);
  });

  it("takes an old tree out with its trunks and crown when a road clears it", () => {
    const WEST = { x: 1, y: 6 };
    const EAST = { x: 22, y: 6 };
    const wood = node(
      "scatter",
      { tiles: [{ tile: "old-tree", weight: 1 }], density: 100, onlyOn: ["grass"] },
      { frame: frame(8, 0, 8, 12) },
    );
    const wooded = buildTree(land({ w: 24, h: 12 }, [wood]));
    expect(walks(wooded, WEST, EAST), sketch(wooded)).toBe(false);
    const cut = buildTree(
      land({ w: 24, h: 12 }, [wood, node("road", { from: WEST, to: EAST, tile: "dirt" })]),
    );
    expect(walks(cut, WEST, EAST), sketch(cut)).toBe(true);
    expect(cutFootprints(cut), sketch(cut)).toEqual([]);
    expect(brokenTallTrees(cut), sketch(cut)).toEqual([]);
  });

  it.each([1, 2, 3])("puts a tile only where its `among` tiles stand thick, seed %i", (seed) => {
    const AT_LEAST = 12;
    const built = buildTree(
      land({ w: 40, h: 24 }, [
        node(
          "forest",
          { density: 100, edge: 2, path: null, undergrowthDensity: 0 },
          { frame: frame(0, 0, 20, 24) },
        ),
        node("scatter", {
          tiles: [{ tile: "tuft", weight: 1 }],
          density: 40,
          clumping: 0,
          onlyOn: ["grass"],
          among: ["tree"],
          amongAtLeast: AT_LEAST,
        }),
      ]),
      { seed },
    );
    const trees = new Set(stands(built, "tree").map((c) => `${c.x},${c.y}`));
    const placed = stands(built, "tuft");
    expect(placed.length, sketch(built)).toBeGreaterThan(0);
    for (const { x, y } of placed) {
      let around = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) if (trees.has(`${x + dx},${y + dy}`)) around++;
      }
      expect(around, `${x},${y}\n${sketch(built)}`).toBeGreaterThanOrEqual(AT_LEAST);
    }
  });
});
