import { describe, expect, it } from "vitest";
import type { MapDoc, MapNode } from "./doc";
import { moveNode, renameNode } from "./edit";

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
