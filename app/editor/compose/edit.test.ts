import { describe, expect, it } from "vitest";
import type { MapDoc, MapNode } from "./doc";
import {
  duplicateTo,
  moveNode,
  pickLayer,
  renameNode,
  topmost,
  translateNodes,
  wrapInGroup,
} from "./edit";
import { layOut, pointIn } from "./layout";

const leaf = (key: string, props?: Record<string, unknown>): MapNode => ({
  type: "ground",
  key,
  ...(props ? { props } : {}),
});

function tree(children: MapNode[]): MapDoc {
  return { version: 1, seed: 1, root: { type: "ground", key: "root", children } };
}

const order = (doc: MapDoc, key = "root"): string[] => {
  const walk = (node: MapNode): MapNode | undefined =>
    node.key === key ? node : node.children?.map(walk).find(Boolean);
  return walk(doc.root)?.children?.map((c) => c.key) ?? [];
};

describe("renameNode", () => {
  it("keeps every point measured in the renamed node's frame pinned to it", () => {
    const doc = tree([
      leaf("town"),
      leaf("road", {
        from: { in: "town", x: 0, y: 0, pinY: "top" },
        to: { in: "inn", x: 1, y: 1 },
        width: 2,
      }),
    ]);
    const renamed = renameNode(doc, "town", "harbour");
    expect(order(renamed)).toEqual(["harbour", "road"]);
    expect(renamed.root.children![1]!.props).toEqual({
      from: { in: "harbour", x: 0, y: 0, pinY: "top" },
      to: { in: "inn", x: 1, y: 1 },
      width: 2,
    });
  });
});

describe("moveNode", () => {
  it.each([
    ["later among its siblings", "a", 3, ["b", "c", "a"]],
    ["earlier among its siblings", "c", 0, ["c", "a", "b"]],
  ])("moves a node %s to the place it is dropped on", (_, key, index, expected) => {
    expect(order(moveNode(tree([leaf("a"), leaf("b"), leaf("c")]), key, "root", index))).toEqual(
      expected,
    );
  });

  it("refuses to move a node into its own subtree", () => {
    const doc = tree([{ ...leaf("town"), children: [leaf("inn")] }]);
    expect(moveNode(doc, "town", "inn", 0)).toBe(doc);
  });
});

const framed = (key: string, x: number, y: number, extra: Partial<MapNode> = {}): MapNode => ({
  type: "ground",
  key,
  frame: { x, y, w: 4, h: 4 },
  ...extra,
});

function world(children: MapNode[]): MapDoc {
  return {
    version: 1,
    seed: 1,
    root: { type: "ground", key: "root", frame: { x: 0, y: 0, w: 40, h: 40 }, children },
  };
}

const boundsOf = (doc: MapDoc, key: string) => layOut(doc).placements.get(key)!.bounds;

describe("translateNodes", () => {
  it("moves from where the drag began, however many times it is called", () => {
    const doc = world([framed("inn", 5, 5, { frame: { x: 5, y: 5, w: 4, h: 4, pinX: "right" } })]);
    const layout = layOut(doc);
    const moves = [{ from: "inn", to: "inn" }];
    const once = translateNodes(doc, layout, moves, 2, 1);
    const again = translateNodes(once, layout, moves, 3, -2);
    const was = boundsOf(doc, "inn");
    expect(boundsOf(again, "inn")).toEqual({
      minX: was.minX + 3,
      maxX: was.maxX + 3,
      minY: was.minY - 2,
      maxY: was.maxY - 2,
    });
  });

  it("moves a layer without a frame by its points, leaving one measured in a layer that moves too", () => {
    const road: MapNode = {
      type: "ground",
      key: "road",
      props: {
        from: { x: 2, y: 3 },
        via: [{ x: 6, y: 6, pinX: "right" }],
        to: { in: "inn", x: 1, y: 1 },
      },
    };
    const doc = world([framed("inn", 10, 10), road]);
    const layout = layOut(doc);
    const moved = translateNodes(
      doc,
      layout,
      [
        { from: "inn", to: "inn" },
        { from: "road", to: "road" },
      ],
      4,
      -1,
    );
    const at = (d: MapDoc, name: string) => {
      const props = d.root.children![1]!.props as Record<string, never>;
      const point = name === "via" ? props.via[0] : props[name];
      return pointIn(point, boundsOf(d, (point as { in?: string }).in ?? "root"));
    };
    for (const name of ["from", "via", "to"]) {
      const was = at(doc, name);
      expect(at(moved, name)).toEqual({ x: was.x + 4, y: was.y - 1 });
    }
  });

  it("writes a copy's move from the original's place, so the original stays", () => {
    const doc = world([framed("inn", 5, 5)]);
    const copied = duplicateTo(doc, "inn", "root", 1);
    const moved = translateNodes(copied.doc, layOut(doc), [{ from: "inn", to: copied.key }], 6, 0);
    expect(boundsOf(moved, "inn")).toEqual(boundsOf(doc, "inn"));
    expect(boundsOf(moved, copied.key).minX).toBe(boundsOf(doc, "inn").minX + 6);
  });
});

describe("topmost", () => {
  it("drops a node whose ancestor is also listed", () => {
    const doc = tree([{ ...leaf("town"), children: [leaf("inn")] }, leaf("road")]);
    expect(topmost(doc.root, ["road", "inn", "town"])).toEqual(["town", "road"]);
  });
});

describe("duplicateTo", () => {
  it("puts a copy with fresh keys where it is dropped and leaves the original", () => {
    const doc = tree([{ ...leaf("town"), children: [leaf("inn")] }, leaf("yard")]);
    const copied = duplicateTo(doc, "town", "yard", 0);
    expect(order(copied.doc)).toEqual(["town", "yard"]);
    expect(order(copied.doc, "yard")).toEqual(["town-copy"]);
    expect(order(copied.doc, "town-copy")).toEqual(["inn-copy"]);
  });
});

describe("wrapInGroup", () => {
  it("groups several nodes where the first stood, in tree order", () => {
    const doc = tree([leaf("a"), leaf("b"), leaf("c"), leaf("d")]);
    const grouped = wrapInGroup(doc, ["d", "b"]);
    expect(order(grouped.doc)).toEqual(["a", grouped.key, "c"]);
    expect(order(grouped.doc, grouped.key)).toEqual(["b", "d"]);
  });
});

describe("pickLayer", () => {
  const lake = framed("lake", 2, 2, { children: [{ ...framed("shape", 0, 0), type: "mask" }] });
  const doc = world([lake, leaf("road")]);
  const built = {
    layout: layOut(doc),
    steps: [
      { key: "root", footprint: null },
      { key: "lake", footprint: null },
      { key: "shape", footprint: null },
      {
        key: "road",
        footprint: { minX: 20, minY: 20, width: 2, height: 1, cells: Uint8Array.of(0, 1) },
      },
    ],
  };

  it("finds a mask only while its layer or one of that layer's masks is selected", () => {
    expect(pickLayer(doc.root, built, { x: 3, y: 3 }, [])).toBe("lake");
    expect(pickLayer(doc.root, built, { x: 3, y: 3 }, ["lake"])).toBe("shape");
  });

  it("finds a layer without a frame on the cells it wrote and nowhere else", () => {
    expect(pickLayer(doc.root, built, { x: 21, y: 20 }, [])).toBe("road");
    expect(pickLayer(doc.root, built, { x: 20, y: 20 }, [])).toBe("root");
  });
});
