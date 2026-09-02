import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { optionAt, resolveDialog, type DialogDef, type DialogOption } from "../lib/dialog";
import { normalizeTiles } from "../lib/types";
import {
  freshOption,
  insertAt,
  isAncestor,
  moveOption,
  parsePathId,
  pathId,
  removeAt,
  updateAt,
} from "./DialogEditor";

/**
 * The moves the dialog editor owns — every edit is a rewrite of the tree by
 * path, and these are the rewrites. Rendering is not tested here; there is no
 * harness for it, and the components are the thin part.
 */

const leaf = (label: string, then?: DialogOption[]): DialogOption =>
  then ? { label, say: label, then } : { label, say: label };

const tree: DialogDef = {
  opening: "Hi.",
  options: [
    leaf("A"),
    leaf("B", [leaf("B0"), leaf("B1", [leaf("B10")])]),
    leaf("C"),
  ],
};

function labels(dialog: DialogDef, path: readonly number[] = []): string[] {
  const options = path.length === 0 ? dialog.options : (optionAt(dialog, path)?.then ?? []);
  return options.map((o) => o.label);
}

describe("naming a path", () => {
  it("round-trips, with the root as its own word", () => {
    expect(pathId([])).toBe("root");
    expect(pathId([1, 0])).toBe("1.0");
    expect(parsePathId("root")).toEqual([]);
    expect(parsePathId("1.0")).toEqual([1, 0]);
  });

  it("knows an ancestor from a sibling and from itself", () => {
    expect(isAncestor([1], [1, 0])).toBe(true);
    expect(isAncestor([], [2])).toBe(true);
    expect(isAncestor([1], [1])).toBe(false);
    expect(isAncestor([1, 0], [1])).toBe(false);
    expect(isAncestor([0], [1, 0])).toBe(false);
  });
});

describe("rewriting by path", () => {
  it("updates one option and leaves the rest as they were", () => {
    const next = updateAt(tree, [1, 1, 0], (o) => ({ ...o, say: "changed" }));
    expect(optionAt(next, [1, 1, 0])?.say).toBe("changed");
    expect(next.options[0]).toBe(tree.options[0]);
    expect(updateAt(tree, [9], (o) => o)).toBe(tree);
  });

  it("inserts among the root and among follow-ups, clamping the index", () => {
    expect(labels(insertAt(tree, [], 1, leaf("X")))).toEqual(["A", "X", "B", "C"]);
    expect(labels(insertAt(tree, [1], 99, leaf("X")), [1])).toEqual(["B0", "B1", "X"]);
    expect(labels(insertAt(tree, [0], 0, leaf("X")), [0])).toEqual(["X"]);
  });

  it("removes an option with its follow-ups, and drops an emptied then", () => {
    const next = removeAt(tree, [1, 1]);
    expect(labels(next, [1])).toEqual(["B0"]);
    const bare = removeAt(next, [1, 0]);
    expect(optionAt(bare, [1])).not.toHaveProperty("then");
    expect(removeAt(tree, [7])).toBe(tree);
  });
});

describe("moving an option", () => {
  it("reorders among siblings", () => {
    expect(labels(moveOption(tree, [2], [], 0))).toEqual(["C", "A", "B"]);
    expect(labels(moveOption(tree, [0], [], 2))).toEqual(["B", "C", "A"]);
  });

  it("moves into another option's follow-ups, last", () => {
    const next = moveOption(tree, [0], [1], Number.MAX_SAFE_INTEGER);
    expect(labels(next)).toEqual(["B", "C"]);
    expect(labels(next, [0])).toEqual(["B0", "B1", "A"]);
  });

  it("re-reads a destination after the removal shifted it", () => {
    // Moving A (index 0) into C (index 2): once A is gone, C is at 1.
    const next = moveOption(tree, [0], [2], 0);
    expect(labels(next)).toEqual(["B", "C"]);
    expect(labels(next, [1])).toEqual(["A"]);
  });

  it("lifts a follow-up out to the root", () => {
    const next = moveOption(tree, [1, 1, 0], [], 1);
    expect(labels(next)).toEqual(["A", "B10", "B", "C"]);
    expect(optionAt(next, [2, 1])).not.toHaveProperty("then");
  });

  it("refuses a move into its own follow-ups, and onto itself", () => {
    expect(moveOption(tree, [1], [1, 1], 0)).toBe(tree);
    expect(moveOption(tree, [1], [1], 0)).toBe(tree);
    expect(moveOption(tree, [9], [], 0)).toBe(tree);
  });
});

describe("a fresh option", () => {
  it("is something the runtime accepts as soon as it is added", () => {
    const tiles = normalizeTiles(tilesJson as unknown[]);
    const salesman = tiles.find((t) => t.id === "potion-salesman")!;
    const dialog = resolveDialog(salesman)!;
    const withFresh = { ...salesman, interactions: { dialog: insertAt(dialog, [], 0, freshOption()) } };
    expect(resolveDialog(withFresh)?.options[0]?.label).toBe("New option");
  });
});
