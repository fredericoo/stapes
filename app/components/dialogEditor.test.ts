import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import {
  commandAt,
  listAt,
  resolveDialog,
  type DialogCommand,
  type DialogDef,
} from "../lib/dialog";
import { DIALOG_COMMANDS } from "../lib/dialogCatalog";
import { normalizeTiles } from "../lib/types";
import {
  insertCommandAt,
  moveCommand,
  parsePathId,
  pathId,
  removeCommandAt,
  startsWith,
  updateCommandAt,
} from "./DialogEditor";

/**
 * The moves the dialog editor owns — every edit is a rewrite of the script
 * by path, and these are the rewrites. Rendering is not tested here; there is
 * no harness for it, and the components are the thin part.
 */

const say = (text: string): DialogCommand => ({ kind: "say", text });

const tree: DialogDef = {
  script: [
    say("A"),
    {
      kind: "choices",
      options: [
        { label: "B0", then: [say("B0a")] },
        { label: "B1", then: [say("B1a"), say("B1b")] },
      ],
    },
    say("C"),
  ],
};

function texts(dialog: DialogDef, listPath: readonly number[] = []): string[] {
  return (listAt(dialog, listPath) ?? []).map((c) =>
    c.kind === "say" ? c.text : c.kind,
  );
}

describe("naming a path", () => {
  it("round-trips, with the root as its own word", () => {
    expect(pathId([])).toBe("root");
    expect(pathId([1, 0])).toBe("1.0");
    expect(parsePathId("root")).toEqual([]);
    expect(parsePathId("1.0")).toEqual([1, 0]);
  });

  it("knows a list under a command from one beside it", () => {
    expect(startsWith([1, 0], [1])).toBe(true);
    expect(startsWith([1], [1])).toBe(true);
    expect(startsWith([2], [1])).toBe(false);
    expect(startsWith([1], [1, 0])).toBe(false);
  });
});

describe("rewriting by path", () => {
  it("updates one command and leaves the rest as they were", () => {
    const next = updateCommandAt(tree, [1, 1, 0], () => say("changed"));
    expect(commandAt(next, [1, 1, 0])).toEqual(say("changed"));
    expect(next.script[0]).toBe(tree.script[0]);
    expect(updateCommandAt(tree, [9], (c) => c)).toBe(tree);
  });

  it("inserts into the root and into a block, clamping the index", () => {
    expect(texts(insertCommandAt(tree, [], 1, say("X")))).toEqual([
      "A",
      "X",
      "choices",
      "C",
    ]);
    expect(texts(insertCommandAt(tree, [1, 0], 99, say("X")), [1, 0])).toEqual([
      "B0a",
      "X",
    ]);
    expect(insertCommandAt(tree, [7, 0], 0, say("X"))).toBe(tree);
  });

  it("removes a command with its blocks", () => {
    expect(texts(removeCommandAt(tree, [1]))).toEqual(["A", "C"]);
    expect(texts(removeCommandAt(tree, [1, 1, 0]), [1, 1])).toEqual(["B1b"]);
    expect(removeCommandAt(tree, [7])).toBe(tree);
  });
});

describe("moving a command", () => {
  it("reorders among neighbours", () => {
    expect(texts(moveCommand(tree, [2], [], 0))).toEqual(["C", "A", "choices"]);
    expect(texts(moveCommand(tree, [0], [], 2))).toEqual(["choices", "C", "A"]);
  });

  it("moves into a block, last", () => {
    const next = moveCommand(tree, [0], [1, 0], Number.MAX_SAFE_INTEGER);
    expect(texts(next)).toEqual(["choices", "C"]);
    expect(texts(next, [0, 0])).toEqual(["B0a", "A"]);
  });

  it("re-reads a destination after the removal shifted it", () => {
    // Moving A (index 0) into the choices at 1: once A is gone, they are at 0.
    const next = moveCommand(tree, [0], [1, 1], 0);
    expect(texts(next, [0, 1])).toEqual(["A", "B1a", "B1b"]);
  });

  it("lifts a command out of a block to the root", () => {
    const next = moveCommand(tree, [1, 1, 0], [], 1);
    expect(texts(next)).toEqual(["A", "B1a", "choices", "C"]);
    expect(texts(next, [2, 1])).toEqual(["B1b"]);
  });

  it("refuses a move into a list the command holds, and a move of nothing", () => {
    expect(moveCommand(tree, [1], [1, 0], 0)).toBe(tree);
    expect(moveCommand(tree, [9], [], 0)).toBe(tree);
  });
});

describe("a fresh command", () => {
  it("is something the runtime accepts as soon as it is added", () => {
    const tiles = normalizeTiles(tilesJson as unknown[]);
    const salesman = tiles.find((t) => t.id === "potion-salesman")!;
    const dialog = resolveDialog(salesman)!;
    const fresh = DIALOG_COMMANDS.choices.make({
      tileId: "arcane-shard",
      statusId: "luminous",
    });
    const withFresh = {
      ...salesman,
      interactions: { dialog: insertCommandAt(dialog, [], 0, fresh) },
    };
    expect(resolveDialog(withFresh)?.script[0]?.kind).toBe("choices");
  });
});
