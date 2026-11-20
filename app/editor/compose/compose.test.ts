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

describe("island", () => {
  it.each([1, 2, 3])("keeps open sea at least %i cells of shallows away from land", (shore) => {
    const { map, problems } = build(
      doc({ type: "island", key: "isle", frame: { x: 0, y: 0, w: 40, h: 30 }, props: { shore } }),
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
    let tree = wrapInGroup(original, "yard").doc;
    tree = moveNode(tree, "lane", "group", 1);
    expect(serializeMap(build(tree).map)).toBe(expected);
    tree = reframeNode(tree, build(tree), "group", "fit");
    expect(tree.root.children![0]!.frame).toBeDefined();
    expect(serializeMap(build(tree).map)).toBe(expected);
    tree = reframeNode(tree, build(tree), "group", null);
    expect(serializeMap(build(tree).map)).toBe(expected);
  });
});
