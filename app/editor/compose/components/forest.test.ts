import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { MAP_DOC_VERSION, parseMapDoc } from "../doc";
import {
  brokenTallTrees,
  buildTree,
  cutFootprints,
  frame,
  land,
  node,
  reach,
  sketch,
  stands,
  tallTreeAt,
} from "../testTree";

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
    "grows old trees whole and apart, fallen logs whole, and keeps the path open through them, seed %i",
    (seed) => {
      const built = buildTree(
        land(SIZE, [
          node("forest", {
            density: 100,
            decay: 30,
            dead: [{ tile: "fallen-log", weight: 1 }],
            path: "dirt",
          }),
        ]),
        { seed },
      );
      expect(stands(built, "old-tree").length, sketch(built)).toBeGreaterThan(0);
      expect(cutFootprints(built), sketch(built)).toEqual([]);
      expect(brokenTallTrees(built), sketch(built)).toEqual([]);
      const trunks = new Set(stands(built, "old-tree").map((b) => tallTreeAt(built, b)?.trunks));
      expect(trunks.size, sketch(built)).toBeGreaterThan(1);
      const bases = stands(built, "old-tree");
      const close = bases.filter((a) =>
        bases.some((b) => a !== b && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 2),
      );
      expect(close, sketch(built)).toEqual([]);
      const path = stands(built, "dirt");
      const walked = reach(built, path[0]!);
      expect(
        path.filter((c) => !walked.has(`0:${c.x},${c.y}`)),
        sketch(built),
      ).toEqual([]);
    },
  );
});

describe("a forest's density and decay", () => {
  const grown = (props: Record<string, unknown>) => {
    const built = buildTree(land(SIZE, [node("forest", { path: null, ...props })]), { seed: 4 });
    const count = (...ids: string[]) => ids.reduce((n, id) => n + stands(built, id).length, 0);
    return {
      cover: count("tuft", "fern", "undergrowth", "red-flowers", "yellow-flowers"),
      trees: count("tree", "apple-tree"),
      tall: count("old-tree"),
      dead: count("dead-tree", "tree-stump", "fallen-log"),
    };
  };

  it("grows only ground cover and bushes below 10", () => {
    const wood = grown({ density: 8 });
    expect(wood.cover).toBeGreaterThan(0);
    expect(wood.trees + wood.tall + wood.dead).toBe(0);
  });

  it("adds trees from 10 and tall trees only from 50", () => {
    const middling = grown({ density: 45 });
    expect(middling.trees).toBeGreaterThan(0);
    expect(middling.tall).toBe(0);
    expect(grown({ density: 90 }).tall).toBeGreaterThan(0);
  });

  it("grows dead trees in place of live ones as decay rises, and only dead ones at 100", () => {
    const some = grown({ density: 90, decay: 40 });
    expect(some.dead).toBeGreaterThan(0);
    expect(some.trees).toBeGreaterThan(0);
    const all = grown({ density: 90, decay: 100 });
    expect(all.dead).toBeGreaterThan(0);
    expect(all.trees + all.tall).toBe(0);
  });
});

describe("a forest's shape", () => {
  const WOOD = { w: 60, h: 40 };
  const FRAME = { x: 4, y: 4, w: 52, h: 32 };
  const wood = (props: Record<string, unknown>, seed = 3) =>
    buildTree(
      land(WOOD, [
        node(
          "forest",
          { path: null, foliage: [], bushes: [], outliers: 0, ...props },
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

  it.each([1, 2, 3, 4])("leaves no open ground cut off from the field outside, seed %i", (seed) => {
    const built = wood({ density: 75 }, seed);
    const walked = reach(built, { x: 0, y: 0 });
    const lost: string[] = [];
    for (let y = FRAME.y; y < FRAME.y + FRAME.h; y++) {
      for (let x = FRAME.x; x < FRAME.x + FRAME.w; x++) {
        const top = getStack(built.map, x, y, 0).at(-1)?.tileId;
        if (top === "grass" && !walked.has(`0:${x},${y}`)) lost.push(`${x},${y}`);
      }
    }
    expect(lost, sketch(built)).toEqual([]);
  });

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

describe("a forest that opens to a road", () => {
  const SIZE = { w: 60, h: 40 };
  const ROAD_X = 40;
  const SAND_W = 4;
  /** Open field left round the wood, so the frame's own edge is somewhere a player can walk. */
  const FIELD = 4;
  const wood = (seed: number, props: Record<string, unknown> = {}) =>
    buildTree(
      land(SIZE, [
        node(
          "fill",
          { tiles: ["sand"], edge: [], mode: "whole stack" },
          { frame: frame(0, 0, SAND_W, SIZE.h) },
        ),
        node(
          "fill",
          { tiles: ["dirt"], edge: [], mode: "whole stack" },
          { frame: frame(ROAD_X, 0, 1, SIZE.h) },
        ),
        node(
          "forest",
          {
            onlyOn: ["grass"],
            density: 80,
            path: null,
            foliage: [],
            bushes: [],
            opensTo: ["dirt"],
            ...props,
          },
          { frame: frame(0, FIELD, SIZE.w - FIELD, SIZE.h - 2 * FIELD) },
        ),
      ]),
      { seed },
    );
  const share = (built: ReturnType<typeof wood>, xs: number[]) => {
    const trees = new Set(stands(built, "tree").map((c) => `${c.x},${c.y}`));
    let cells = 0;
    let found = 0;
    for (const x of xs) {
      for (let y = FIELD + 4; y < SIZE.h - FIELD - 4; y++) {
        cells++;
        if (trees.has(`${x},${y}`)) found++;
      }
    }
    return found / cells;
  };

  it.each([1, 2, 3])("is thick against other ground and thin beside the road, seed %i", (seed) => {
    const built = wood(seed);
    const besideRoad = share(built, [ROAD_X - 2, ROAD_X - 1, ROAD_X + 1, ROAD_X + 2]);
    const besideSand = share(built, [SAND_W, SAND_W + 1, SAND_W + 2]);
    expect(besideRoad, sketch(built)).toBeLessThan(besideSand / 3);
  });

  it("thins against other ground when it opens to nothing", () => {
    const built = wood(1, { opensTo: [] });
    const besideSand = share(built, [SAND_W, SAND_W + 1]);
    const deep = share(built, [SAND_W + 14, SAND_W + 15]);
    expect(besideSand, sketch(built)).toBeLessThan(deep / 3);
  });

  it.each([1, 2, 3, 4])(
    "leaves no open ground that cannot be walked to from the road, seed %i",
    (seed) => {
      const built = wood(seed);
      const walked = reach(built, { x: ROAD_X, y: SIZE.h / 2 });
      const lost: string[] = [];
      for (let y = 0; y < SIZE.h; y++) {
        for (let x = SAND_W; x < SIZE.w; x++) {
          const top = getStack(built.map, x, y, 0).at(-1)?.tileId;
          if (top === "grass" && !walked.has(`0:${x},${y}`)) lost.push(`${x},${y}`);
        }
      }
      expect(lost, sketch(built)).toEqual([]);
    },
  );
});
