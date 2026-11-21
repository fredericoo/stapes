import * as v from "valibot";
import { describe, expect, it } from "vitest";
import tilesRaw from "../../../data/tiles.json";
import { chunkKeyFor, getStack, serializeMap } from "../../lib/mapData";
import type { MapFile } from "../../lib/types";
import { normalizeTiles } from "../../lib/types";
import { tilesByIdFromList } from "../../lib/validation";
import { buildMap, type Component, type ComponentRegistry } from "./build";
import { COMPONENTS } from "./components";
import type { Frame, MapDoc, MapNode } from "./doc";
import { moveNode, reframeNode, wrapInGroup } from "./edit";

const tilesById = tilesByIdFromList(normalizeTiles(tilesRaw as unknown[]));

const ground: Component<{ tile: string }> = {
  type: "ground",
  label: "Ground",
  starter: {},
  schema: v.object({ tile: v.optional(v.string(), "sand") }),
  build(ctx, props) {
    const edits = [];
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        edits.push({ x, y, z: ctx.z, stack: [{ tileId: props.tile }] });
      }
    }
    return { ok: true, edits };
  },
};

const registry: ComponentRegistry = { ...COMPONENTS, ground: ground as Component<never> };

function doc(root: MapNode, seed = 7): MapDoc {
  return { version: 1, seed, root };
}

function field(children: MapNode[], frame: Frame = { x: 0, y: 0, w: 40, h: 30 }): MapNode {
  return { type: "ground", key: "field", frame, children };
}

function build(tree: MapDoc) {
  return buildMap(tree, tilesById, registry);
}

function topAt(map: MapFile, x: number, y: number): string | undefined {
  return getStack(map, x, y, 0).at(-1)?.tileId;
}

function cellsWith(map: MapFile, tileId: string, w: number, h: number): string[] {
  const cells: string[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (getStack(map, x, y, 0).some((p) => p.tileId === tileId)) cells.push(`${x},${y}`);
    }
  }
  return cells;
}

const wood = (seed?: number): MapNode => ({
  type: "forest",
  key: "wood",
  ...(seed === undefined ? {} : { seed }),
  frame: { x: 4, y: 4, w: 20, h: 16 },
  props: { onlyOn: ["sand"], path: null },
});

describe("buildMap", () => {
  it("builds the same tree into the same map every time", () => {
    const tree = doc({
      type: "island",
      key: "isle",
      frame: { x: 0, y: 0, w: 48, h: 36 },
      children: [wood()],
    });
    expect(serializeMap(build(tree).map)).toBe(serializeMap(build(tree).map));
  });

  it("re-rolls only the node whose seed changed, wherever its siblings are", () => {
    const trees = (tree: MapDoc) => cellsWith(build(tree).map, "tree", 40, 30);
    const before = trees(doc(field([wood()])));

    const reordered = doc(
      field([
        { type: "forest", key: "copse", seed: 99, frame: { x: 26, y: 2, w: 12, h: 12 } },
        wood(),
      ]),
    );
    const inWood = (cell: string) => {
      const [x, y] = cell.split(",").map(Number) as [number, number];
      return x >= 4 && x < 24 && y >= 4 && y < 20;
    };
    expect(trees(reordered).filter(inWood)).toEqual(before);
    expect(trees(doc({ ...field([wood()]), seed: 555 }))).toEqual(before);
    expect(trees(doc(field([wood(12345)])))).not.toEqual(before);
  });

  it("moves a road's end with the edge of the frame it is pinned to", () => {
    const tree = (townY: number, townH: number) =>
      doc(
        field([
          { type: "ground", key: "town", frame: { x: 10, y: townY, w: 9, h: townH } },
          {
            type: "road",
            key: "north-road",
            props: {
              tile: "cobblestone",
              from: { in: "town", x: 0, y: -1, pinX: "center", pinY: "top" },
              to: { x: 14, y: 0 },
            },
          },
        ]),
      );
    const short = build(tree(15, 8)).map;
    const grown = build(tree(10, 13)).map;
    expect(topAt(short, 14, 14)).toBe("cobblestone");
    expect(topAt(grown, 14, 14)).toBe("sand");
    expect(topAt(grown, 14, 9)).toBe("cobblestone");
  });

  it("bridges a river a road is drawn after, and washes out a road a river is drawn after", () => {
    const river: MapNode = {
      type: "river",
      key: "brook",
      props: { from: { x: 20, y: 0 }, to: { x: 20, y: 29 }, width: 1 },
    };
    const road: MapNode = {
      type: "road",
      key: "lane",
      props: { tile: "cobblestone", from: { x: 0, y: 15 }, to: { x: 39, y: 15 } },
    };
    const bridged = build(doc(field([river, road]))).map;
    const washed = build(doc(field([road, river]))).map;
    expect(topAt(bridged, 20, 15)).toBe("wooden-floor");
    expect(topAt(bridged, 20, 14)).toBe("fence");
    expect(topAt(washed, 20, 15)).toBe("water");
    expect(topAt(washed, 19, 15)).toBe("cobblestone");
  });

  it("grows a forest only on the tiles it is allowed on", () => {
    const tree = doc(
      field([
        {
          type: "ground",
          key: "meadow",
          frame: { x: 0, y: 0, w: 14, h: 30 },
          props: { tile: "grass-2" },
        },
        { ...wood(), props: { onlyOn: ["sand"], path: null, density: 100 } },
      ]),
    );
    const trees = cellsWith(build(tree).map, "tree", 40, 30);
    expect(trees.length).toBeGreaterThan(0);
    expect(trees.every((cell) => Number(cell.split(",")[0]) >= 14)).toBe(true);
  });

  it("reports a node that cannot be built by its key and still builds its siblings", () => {
    const { map, problems } = build(
      doc(
        field([
          { type: "house", key: "shed", frame: { x: 2, y: 2, w: 2, h: 2 } },
          { type: "house", key: "shed", frame: { x: 30, y: 2, w: 5, h: 5 } },
          {
            type: "road",
            key: "lane",
            props: { tile: "cobblestone", from: { x: 0, y: 20 }, to: { x: 10, y: 20 } },
          },
        ]),
      ),
    );
    expect(problems.map((p) => p.key)).toEqual(["shed", "shed"]);
    expect(topAt(map, 5, 20)).toBe("cobblestone");
  });

  it("refuses a tile that is not the kind its field asks for", () => {
    const { problems } = build(
      doc(
        field([
          {
            type: "house",
            key: "shed",
            frame: { x: 2, y: 2, w: 6, h: 6 },
            props: { wall: "tree" },
          },
        ]),
      ),
    );
    expect(problems).toEqual([{ key: "shed", reason: "wall: Tree is not a wall" }]);
  });

  it("places a tile with its placement settings and no facing it cannot take", () => {
    const { map, problems } = build(
      doc(
        field([
          {
            type: "tile",
            key: "loot",
            props: {
              tile: "quest-chest",
              at: { x: 5, y: 6 },
              facing: "e",
              placement: { rewardTag: "first-chest", rewardTileIds: ["apple"], direction: "n" },
            },
          },
        ]),
      ),
    );
    expect(problems).toEqual([]);
    expect(getStack(map, 5, 6, 0).at(-1)).toEqual({
      tileId: "quest-chest",
      rewardTag: "first-chest",
      rewardTileIds: ["apple"],
    });
  });

  it("writes nothing outside its parent's frame", () => {
    const { map } = build(
      doc(
        field([
          {
            type: "ground",
            key: "yard",
            frame: { x: 2, y: 2, w: 6, h: 6 },
            children: [
              {
                type: "ground",
                key: "spill",
                frame: { x: -4, y: 0, w: 20, h: 3 },
                props: { tile: "dirt" },
              },
            ],
          },
        ]),
      ),
    );
    expect(cellsWith(map, "dirt", 40, 30).sort()).toEqual(
      [
        "2,2",
        "3,2",
        "4,2",
        "5,2",
        "6,2",
        "7,2",
        "2,3",
        "3,3",
        "4,3",
        "5,3",
        "6,3",
        "7,3",
        "2,4",
        "3,4",
        "4,4",
        "5,4",
        "6,4",
        "7,4",
      ].sort(),
    );
  });
});

const sea = (children: MapNode[]): MapNode => ({
  type: "sea",
  key: "sea",
  frame: { x: 0, y: 0, w: 40, h: 30 },
  children,
});

const landOf = (map: MapFile) => {
  const cells: string[] = [];
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 40; x++) {
      const stack = getStack(map, x, y, 0);
      if (
        stack.length > 0 &&
        !stack.some((p) => p.tileId === "water" || p.tileId === "deep-water")
      ) {
        cells.push(`${x},${y}`);
      }
    }
  }
  return cells;
};

describe("island", () => {
  it("writes its land and shallows and nothing further out", () => {
    const { map } = build(
      doc({
        type: "group",
        key: "nothing",
        frame: { x: 0, y: 0, w: 40, h: 30 },
        children: [{ type: "island", key: "isle", props: { shore: 1 } }],
      }),
    );
    expect(cellsWith(map, "deep-water", 40, 30)).toEqual([]);
    expect(getStack(map, 0, 0, 0)).toEqual([]);
  });

  it("merges with an island it overlaps instead of cutting water through its land", () => {
    const west: MapNode = {
      type: "island",
      key: "west",
      frame: { x: 0, y: 0, w: 26, h: 30 },
      props: { roughness: 0 },
    };
    const east: MapNode = {
      type: "island",
      key: "east",
      frame: { x: 14, y: 0, w: 26, h: 30 },
      props: { roughness: 0 },
    };
    const alone = new Set([
      ...landOf(build(doc(sea([west]))).map),
      ...landOf(build(doc(sea([east]))).map),
    ]);
    const together = new Set(landOf(build(doc(sea([west, east]))).map));
    expect([...alone].filter((cell) => !together.has(cell))).toEqual([]);
  });

  it.each([1, 2, 3])("keeps open sea at least %i cells of shallows away from land", (shore) => {
    const { map, problems } = build(
      doc(
        sea([
          { type: "island", key: "isle", frame: { x: 0, y: 0, w: 40, h: 30 }, props: { shore } },
        ]),
      ),
    );
    expect(problems).toEqual([]);
    const land: Array<[number, number]> = [];
    const deep: Array<[number, number]> = [];
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 40; x++) {
        const stack = getStack(map, x, y, 0);
        if (stack.length === 1 && stack[0]!.tileId === "sand") land.push([x, y]);
        if (stack.some((p) => p.tileId === "deep-water")) deep.push([x, y]);
      }
    }
    expect(land.length).toBeGreaterThan(0);
    let nearest = Infinity;
    for (const [dx, dy] of deep) {
      for (const [lx, ly] of land)
        nearest = Math.min(nearest, Math.abs(dx - lx) + Math.abs(dy - ly));
    }
    expect(nearest).toBe(shore + 1);
  });
});

describe("rebuilding after an edit", () => {
  const tree = (townX: number) =>
    doc(
      field(
        [
          {
            type: "road",
            key: "lane",
            props: {
              tile: "cobblestone",
              from: { in: "town", x: 0, y: -1, pinX: "center" },
              to: { x: 0, y: 40, pinY: "bottom" },
            },
          },
          {
            type: "ground",
            key: "town",
            frame: { x: townX, y: 20, w: 8, h: 8 },
            props: { tile: "dirt" },
          },
          wood(),
        ],
        { x: 0, y: 0, w: 64, h: 64 },
      ),
    );

  it("builds what a full build would, even for a node measured in one that moved after it", () => {
    const previous = build(tree(30));
    const resumed = buildMap(tree(44), tilesById, registry, undefined, previous);
    expect(resumed.reused).toBe(1);
    expect(serializeMap(resumed.map)).toBe(serializeMap(build(tree(44)).map));
  });

  it("hands back the previous chunk object for a node rebuilt over cells that came out the same", () => {
    const previous = build(tree(30));
    const resumed = buildMap(tree(44), tilesById, registry, undefined, previous);
    const forestChunk = chunkKeyFor(8, 8);
    expect(resumed.reused).toBe(1);
    expect(resumed.map.levels["0"]![forestChunk]).toBe(previous.map.levels["0"]![forestChunk]);
  });
});

describe("grouping", () => {
  it("moves nothing when layers are grouped, framed round their contents, and unframed", () => {
    const original = doc(
      field([
        {
          type: "ground",
          key: "yard",
          frame: { x: 22, y: 6, w: 10, h: 8, pinX: "right" },
          props: { tile: "dirt" },
        },
        {
          type: "road",
          key: "lane",
          props: {
            tile: "cobblestone",
            from: { x: 2, y: 25 },
            to: { x: 0.8, y: 4, pinX: "scale", pinY: "bottom" },
          },
        },
      ]),
    );
    const expected = serializeMap(build(original).map);
    let tree = wrapInGroup(original, ["yard"]).doc;
    tree = moveNode(tree, "lane", "group", 1);
    expect(serializeMap(build(tree).map)).toBe(expected);
    tree = reframeNode(tree, build(tree), "group", "fit");
    expect(tree.root.children![0]!.frame).toBeDefined();
    expect(serializeMap(build(tree).map)).toBe(expected);
    tree = reframeNode(tree, build(tree), "group", null);
    expect(serializeMap(build(tree).map)).toBe(expected);
  });
});

describe("routes", () => {
  const river = (props: Record<string, unknown>): MapNode => ({
    type: "river",
    key: "brook",
    props: {
      from: { x: 0, y: 15 },
      via: [{ x: 20, y: 5 }],
      to: { x: 39, y: 15 },
      width: 1,
      ...props,
    },
  });
  const wet = (map: MapFile, x: number, y: number) => topAt(map, x, y) === "water";

  it.each([0, 60, 100])(
    "passes through its start, every via point and its end at wander %i",
    (wander) => {
      const { map } = build(doc(field([river({ wander })])));
      expect([wet(map, 0, 15), wet(map, 20, 5), wet(map, 39, 15)]).toEqual([true, true, true]);
    },
  );

  it("bends away from the straight line when it wanders", () => {
    const straight = cellsWith(build(doc(field([river({ wander: 0 })]))).map, "water", 40, 30);
    const bent = cellsWith(build(doc(field([river({ wander: 80 })]))).map, "water", 40, 30);
    expect(bent.filter((c) => !straight.includes(c)).length).toBeGreaterThan(5);
  });
});

describe("masks", () => {
  const thicket = (masks: MapNode[], props: Record<string, unknown> = {}): MapDoc =>
    doc(
      field([
        {
          type: "forest",
          key: "wood",
          frame: { x: 0, y: 0, w: 40, h: 30 },
          props: { onlyOn: ["sand"], path: null, density: 100, undergrowthDensity: 0, ...props },
          children: masks,
        },
      ]),
    );
  const oval = (op: string): MapNode => ({
    type: "mask",
    key: `oval-${op}`,
    frame: { x: 10, y: 8, w: 20, h: 14 },
    props: { shape: "oval", op },
  });
  const everything: MapNode = {
    type: "mask",
    key: "all",
    props: { shape: "rect", op: "subtract" },
  };
  const inOval = (cell: string) => {
    const [x, y] = cell.split(",").map(Number) as [number, number];
    return Math.hypot((x + 0.5 - 20) / 10, (y + 0.5 - 15) / 7) <= 1;
  };
  const treesAt = (tree: MapDoc) => {
    const trees = cellsWith(build(tree).map, "tree", 40, 30);
    return {
      inside: trees.some((c) => inOval(c)),
      outside: trees.some((c) => !inOval(c)),
    };
  };

  it.each([
    ["subtracting an oval clears it", [oval("subtract")], { inside: false, outside: true }],
    ["intersecting an oval keeps only it", [oval("intersect")], { inside: true, outside: false }],
    [
      "adding an oval back after subtracting all",
      [everything, oval("add")],
      { inside: true, outside: false },
    ],
  ])("%s", (_, masks, expected) => {
    expect(treesAt(thicket(masks as MapNode[]))).toEqual(expected);
  });

  it("removes only the tiles it lists and leaves the ground the layer was built on", () => {
    const tree = thicket(
      [{ type: "mask", key: "no-trees", props: { shape: "rect", only: ["tree"] } }],
      { undergrowthDensity: 100 },
    );
    const { map } = build(tree);
    expect(cellsWith(map, "tree", 40, 30)).toEqual([]);
    expect(cellsWith(map, "small-bush", 40, 30).length).toBeGreaterThan(0);
    expect(getStack(map, 20, 15, 0)[0]).toEqual({ tileId: "sand" });
  });

  it("rebuilds its layer when it moves, even though it comes after it", () => {
    const at = (x: number) => thicket([{ ...oval("subtract"), frame: { x, y: 8, w: 20, h: 14 } }]);
    const resumed = buildMap(at(16), tilesById, registry, undefined, build(at(4)));
    expect(serializeMap(resumed.map)).toBe(serializeMap(build(at(16)).map));
  });
});

describe("layer masks and clearing", () => {
  const brook: MapNode = {
    type: "river",
    key: "brook",
    props: { from: { x: 20, y: 0 }, to: { x: 20, y: 29 }, width: 1 },
  };

  it("keeps a layer to the cells beside another layer when masked from it", () => {
    const { map } = build(
      doc(
        field([
          brook,
          {
            type: "ground",
            key: "banks",
            props: { tile: "dirt" },
            children: [
              {
                type: "mask",
                key: "near-brook",
                props: { from: "brook", op: "intersect", grow: 2 },
              },
            ],
          },
        ]),
      ),
    );
    expect([
      topAt(map, 22, 15),
      topAt(map, 23, 15),
      topAt(map, 18, 15),
      topAt(map, 17, 15),
    ]).toEqual(["dirt", "sand", "dirt", "sand"]);
  });

  it("refuses a mask from a layer that is built after the one it shapes", () => {
    const { problems } = build(
      doc(
        field([
          {
            type: "ground",
            key: "banks",
            props: { tile: "dirt" },
            children: [
              { type: "mask", key: "near-brook", props: { from: "brook", op: "intersect" } },
            ],
          },
          brook,
        ]),
      ),
    );
    expect(problems.map((p) => p.key)).toEqual(["near-brook"]);
  });

  it("clears only the listed tiles, only where its mask leaves it in", () => {
    const { map } = build(
      doc(
        field([
          {
            type: "forest",
            key: "wood",
            props: { onlyOn: ["sand"], path: null, density: 100, undergrowthDensity: 100 },
          },
          {
            type: "clear",
            key: "felled",
            props: { remove: ["tree"] },
            children: [
              {
                type: "mask",
                key: "left-half",
                frame: { x: 0, y: 0, w: 20, h: 30 },
                props: { shape: "rect", op: "intersect" },
              },
            ],
          },
        ]),
      ),
    );
    const trees = cellsWith(map, "tree", 40, 30).map((c) => Number(c.split(",")[0]));
    const bushes = cellsWith(map, "small-bush", 40, 30).map((c) => Number(c.split(",")[0]));
    expect(trees.length).toBeGreaterThan(0);
    expect(trees.every((x) => x >= 20)).toBe(true);
    expect(bushes.some((x) => x < 20)).toBe(true);
  });
});

describe("fill and scatter", () => {
  it("lays its edge stack in a band round its middle", () => {
    const { map } = build(
      doc(
        field([
          {
            type: "fill",
            key: "pond",
            frame: { x: 10, y: 10, w: 10, h: 10 },
            props: {
              tiles: ["water", "deep-water"],
              edge: ["water"],
              edgeWidth: 2,
              mode: "replace",
            },
          },
        ]),
      ),
    );
    expect([topAt(map, 9, 15), topAt(map, 10, 15), topAt(map, 11, 15), topAt(map, 12, 15)]).toEqual(
      ["sand", "water", "water", "deep-water"],
    );
    expect(getStack(map, 15, 15, 0).map((p) => p.tileId)).toEqual(["sand", "water", "deep-water"]);
  });

  it("scatters only on its ground and never two within its spacing", () => {
    const { map } = build(
      doc(
        field([
          {
            type: "ground",
            key: "meadow",
            frame: { x: 0, y: 0, w: 20, h: 30 },
            props: { tile: "grass-2" },
          },
          {
            type: "scatter",
            key: "flowers",
            props: {
              tiles: [{ tile: "red-flowers", weight: 1 }],
              density: 100,
              clumping: 0,
              spacing: 2,
              onlyOn: ["sand"],
            },
          },
        ]),
      ),
    );
    const placedAt = cellsWith(map, "red-flowers", 40, 30).map(
      (c) => c.split(",").map(Number) as [number, number],
    );
    expect(placedAt.length).toBeGreaterThan(10);
    expect(placedAt.every(([x]) => x >= 20)).toBe(true);
    for (const [ax, ay] of placedAt) {
      for (const [bx, by] of placedAt) {
        if (ax === bx && ay === by) continue;
        expect(Math.max(Math.abs(ax - bx), Math.abs(ay - by))).toBeGreaterThan(2);
      }
    }
  });
});

describe("bridges", () => {
  it("crosses water as one straight bridge resting one cell on each bank, however the road meets it", () => {
    const { map } = build(
      doc(
        field([
          {
            type: "river",
            key: "brook",
            props: { from: { x: 20, y: 0 }, to: { x: 20, y: 29 }, width: 3 },
          },
          {
            type: "road",
            key: "lane",
            props: { tile: "cobblestone", from: { x: 0, y: 5 }, to: { x: 39, y: 25 }, rail: null },
          },
        ]),
      ),
    );
    const deck = cellsWith(map, "wooden-floor", 40, 30).map(
      (c) => c.split(",").map(Number) as [number, number],
    );
    const rows = new Set(deck.map(([, y]) => y));
    expect(rows.size).toBe(1);
    expect(deck.map(([x]) => x).sort((a, b) => a - b)).toEqual([18, 19, 20, 21, 22]);
  });
});

describe("bridges with rails", () => {
  it("lays deck and rail in one rectangle that covers the cell on each bank", () => {
    const { map } = build(
      doc(
        field([
          {
            type: "river",
            key: "brook",
            props: { from: { x: 20, y: 0 }, to: { x: 20, y: 29 }, width: 3 },
          },
          {
            type: "road",
            key: "lane",
            props: { tile: "cobblestone", from: { x: 0, y: 5 }, to: { x: 39, y: 25 } },
          },
        ]),
      ),
    );
    const cells = (tileId: string) =>
      cellsWith(map, tileId, 40, 30).map((c) => c.split(",").map(Number) as [number, number]);
    const deck = cells("wooden-floor");
    const xs = [...new Set(deck.map(([x]) => x))].sort((a, b) => a - b);
    const ys = [...new Set(deck.map(([, y]) => y))].sort((a, b) => a - b);
    expect(xs).toEqual([18, 19, 20, 21, 22]);
    expect(ys).toHaveLength(3);
    expect(deck).toHaveLength(15);
    expect(cells("fence").map(([x, y]) => `${x},${y}`)).toEqual(
      [ys[0]!, ys[2]!].flatMap((y) => xs.map((x) => `${x},${y}`)),
    );
  });
});

describe("a mask on a layer that shapes itself", () => {
  it("rings a hole cut in an island with shallows and foam instead of leaving the sea against the sand", () => {
    const { map, problems } = build(
      doc({
        type: "sea",
        key: "sea",
        frame: { x: 0, y: 0, w: 48, h: 36 },
        children: [
          {
            type: "island",
            key: "isle",
            frame: { x: 0, y: 0, w: 48, h: 36 },
            props: { roughness: 0 },
            children: [
              {
                type: "mask",
                key: "hole",
                frame: { x: 18, y: 12, w: 12, h: 12 },
                props: { shape: "rect", op: "subtract" },
              },
            ],
          },
        ],
      }),
    );
    expect(problems).toEqual([]);
    const ids = (x: number, y: number) => getStack(map, x, y, 0).map((p) => p.tileId);
    expect(ids(17, 18)).toEqual(["sand"]);
    expect(ids(18, 18)).toEqual(["sand", "water", "shore-foam"]);
    expect(ids(19, 18)).toEqual(["sand", "water"]);
    expect(ids(24, 18)).toEqual(["water", "deep-water"]);
  });
});

describe("fill in ground mode", () => {
  it("replaces the tile under what stands on a cell and leaves water as it is", () => {
    const { map } = build(
      doc(
        field([
          wood(),
          {
            type: "river",
            key: "brook",
            props: { from: { x: 30, y: 0 }, to: { x: 30, y: 29 }, width: 1 },
          },
          {
            type: "fill",
            key: "meadow",
            frame: { x: 0, y: 0, w: 40, h: 30 },
            props: { tiles: ["grass-2"], mode: "ground", edge: [], onlyOn: ["sand"] },
          },
        ]),
      ),
    );
    const trees = cellsWith(map, "tree", 40, 30);
    expect(trees.length).toBeGreaterThan(0);
    for (const cell of trees) {
      const [x, y] = cell.split(",").map(Number) as [number, number];
      expect(getStack(map, x, y, 0)[0]?.tileId, cell).toBe("grass-2");
    }
    expect(cellsWith(map, "sand", 40, 30)).toEqual(cellsWith(map, "water", 40, 30));
  });
});
