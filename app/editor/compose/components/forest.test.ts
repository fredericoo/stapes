import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { MAP_DOC_VERSION, parseMapDoc } from "../doc";
import { buildTree, cutFootprints, frame, land, node, reach, sketch, stands } from "../testTree";
import { MIN_GLADE_CELLS } from "../woodland";

const SIZE = { w: 30, h: 20 };

describe("forest", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "keeps a path walkable from one edge of a solid wood to the opposite edge, seed %i",
    (seed) => {
      const built = buildTree(land(SIZE, [node("forest", { density: 100, path: "dirt" })]), {
        seed,
      });
      const path: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < SIZE.h; y++) {
        for (let x = 0; x < SIZE.w; x++) {
          if (getStack(built.map, x, y, 0).at(-1)?.tileId === "dirt") path.push({ x, y });
        }
      }
      expect(path.length, sketch(built)).toBeGreaterThan(0);
      const walked = [...reach(built, path[0]!).values()];
      const sides = [
        walked.some((c) => c.x === 0) && walked.some((c) => c.x === SIZE.w - 1),
        walked.some((c) => c.y === 0) && walked.some((c) => c.y === SIZE.h - 1),
      ];
      expect(sides, sketch(built)).toContain(true);
    },
  );

  it.each([1, 2, 3])(
    "grows old trees and fallen logs whole and keeps the path open through them, seed %i",
    (seed) => {
      const built = buildTree(
        land(SIZE, [
          node("forest", {
            trees: [{ tile: "old-tree", weight: 1 }],
            density: 100,
            path: "dirt",
            undergrowth: [{ tile: "fallen-log", weight: 1 }],
            undergrowthDensity: 30,
          }),
        ]),
        { seed },
      );
      expect(stands(built, "old-tree").length, sketch(built)).toBeGreaterThan(0);
      expect(cutFootprints(built), sketch(built)).toEqual([]);
      const path = stands(built, "dirt");
      const walked = reach(built, path[0]!);
      expect(
        path.filter((c) => !walked.has(`0:${c.x},${c.y}`)),
        sketch(built),
      ).toEqual([]);
    },
  );
});

describe("a forest's shape", () => {
  const WOOD = { w: 60, h: 40 };
  const FRAME = { x: 4, y: 4, w: 52, h: 32 };
  const wood = (props: Record<string, unknown>, seed = 3) =>
    buildTree(
      land(WOOD, [
        node(
          "forest",
          { path: null, undergrowthDensity: 0, outliers: 0, ...props },
          { frame: frame(FRAME.x, FRAME.y, FRAME.w, FRAME.h) },
        ),
      ]),
      { seed },
    );
  const treeAt = (built: ReturnType<typeof wood>) => {
    const trees = new Set([...stands(built, "tree"), ...stands(built, "old-tree")].map(at));
    return (x: number, y: number) => trees.has(`${x},${y}`);
  };
  const at = (c: { x: number; y: number }) => `${c.x},${c.y}`;
  const fromEdge = (x: number, y: number) =>
    Math.min(x - FRAME.x, FRAME.x + FRAME.w - 1 - x, y - FRAME.y, FRAME.y + FRAME.h - 1 - y);
  const share = (tree: (x: number, y: number) => boolean, keep: (d: number) => boolean) => {
    let cells = 0;
    let trees = 0;
    for (let y = FRAME.y; y < FRAME.y + FRAME.h; y++) {
      for (let x = FRAME.x; x < FRAME.x + FRAME.w; x++) {
        if (!keep(fromEdge(x, y))) continue;
        cells++;
        if (tree(x, y)) trees++;
      }
    }
    return trees / cells;
  };

  it.each([1, 2, 3])("thins out towards the edge of its frame, seed %i", (seed) => {
    const built = wood({ density: 100 }, seed);
    const tree = treeAt(built);
    const rim = share(tree, (d) => d <= 1);
    const deep = share(tree, (d) => d >= 10);
    expect(rim, sketch(built)).toBeLessThan(deep / 4);
  });

  it.each([1, 2, 3, 4])(
    "leaves no glade worth reaching cut off from the field outside, seed %i",
    (seed) => {
      const built = wood({ density: 75 }, seed);
      const walked = reach(built, { x: 0, y: 0 });
      const lost = new Set<string>();
      for (let y = FRAME.y; y < FRAME.y + FRAME.h; y++) {
        for (let x = FRAME.x; x < FRAME.x + FRAME.w; x++) {
          const top = getStack(built.map, x, y, 0).at(-1)?.tileId;
          if (top === "grass" && !walked.has(`0:${x},${y}`)) lost.add(`${x},${y}`);
        }
      }
      const pockets: number[] = [];
      const seen = new Set<string>();
      for (const start of lost) {
        if (seen.has(start)) continue;
        seen.add(start);
        const queue = [start];
        for (let head = 0; head < queue.length; head++) {
          const [x, y] = queue[head]!.split(",").map(Number) as [number, number];
          for (const next of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
            if (lost.has(next) && !seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
        pockets.push(queue.length);
      }
      expect(Math.max(0, ...pockets), sketch(built)).toBeLessThan(MIN_GLADE_CELLS);
    },
  );

  it("grows its mix of trees in stands of one kind rather than evenly salted", () => {
    const built = wood({
      density: 100,
      trees: [
        { tile: "tree", weight: 1 },
        { tile: "dead-tree", weight: 1 },
      ],
    });
    const kind = new Map<string, string>();
    for (const id of ["tree", "dead-tree"]) for (const c of stands(built, id)) kind.set(at(c), id);
    let pairs = 0;
    let same = 0;
    for (const [cell, id] of kind) {
      const [x, y] = cell.split(",").map(Number) as [number, number];
      for (const next of [`${x + 1},${y}`, `${x},${y + 1}`]) {
        const other = kind.get(next);
        if (!other) continue;
        pairs++;
        if (other === id) same++;
      }
    }
    expect(stands(built, "dead-tree").length).toBeGreaterThan(20);
    expect(stands(built, "tree").length).toBeGreaterThan(20);
    expect(same / pairs).toBeGreaterThan(0.7);
  });

  it("reads a saved forest's single tree as a mix of one", () => {
    const parsed = parseMapDoc({
      version: MAP_DOC_VERSION,
      seed: 1,
      root: { type: "forest", key: "orchard", props: { tree: "apple-tree", density: 40 } },
    });
    expect(parsed.ok && parsed.doc.root.props).toEqual({
      trees: [{ tile: "apple-tree", weight: 1 }],
      density: 40,
    });
  });
});
