import { describe, expect, it } from "vitest";
import {
  anchorNames,
  anchorPath,
  branchesOf,
  clampAmount,
  commandAt,
  DEFAULT_DIALOG,
  listAt,
  MAX_DIALOG_DEPTH,
  resolveDialog,
  validateDialog,
  walkCommands,
  withListAt,
  type DialogCommand,
  type DialogDef,
  type DialogTrade,
} from "./dialog";
import { normalizeTileDef } from "./types";

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tileWith(dialog: unknown, id = "seller", item?: unknown) {
  return normalizeTileDef({
    id,
    name: id,
    height: 4,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: item ? "item" : "prop",
    interactions: { ...(dialog === undefined ? {} : { dialog }), ...(item ? { item } : {}) },
  });
}

const say = (text: string): DialogCommand => ({ kind: "say", text });

const trade: DialogTrade = {
  kind: "request_trade",
  take: [{ tileId: "shard", count: 14 }],
  give: [{ tileId: "potion", count: 1 }],
  min: 1,
  max: 4,
  traded: [say("Thanks.")],
  cancel: [say("Fine.")],
};

const shop: DialogDef = {
  script: [
    say("Hello."),
    { kind: "anchor", name: "main" },
    {
      kind: "choices",
      options: [
        { label: "Buy", then: [say("Fourteen."), trade] },
        { label: "How", then: [say("Crystals."), { kind: "goto", name: "main" }] },
      ],
    },
  ],
};

describe("resolving a dialog", () => {
  it("parses a script and trims its names", () => {
    const dialog = resolveDialog(tileWith({ script: [{ kind: "anchor", name: " main " }] }));
    expect(dialog?.script[0]).toEqual({ kind: "anchor", name: "main" });
  });

  it("is null for a tile with no dialog", () => {
    expect(resolveDialog(tileWith(undefined))).toBeNull();
  });

  it("refuses a blank line, choices with no buttons, a trade of nothing, and an inverted range", () => {
    const bad = (command: Record<string, unknown>) => resolveDialog(tileWith({ script: [command] }));
    expect(bad({ kind: "say", text: "" })).toBeNull();
    expect(bad({ kind: "choices", options: [] })).toBeNull();
    expect(bad({ ...trade, take: [], give: [] })).toBeNull();
    expect(bad({ ...trade, min: 3, max: 2 })).toBeNull();
    expect(bad({ kind: "unknown" })).toBeNull();
  });

  it("parses nested blocks all the way down", () => {
    expect(resolveDialog(tileWith(shop))).toEqual(shop);
  });

  it("is memoised on the def", () => {
    const def = tileWith(shop);
    expect(resolveDialog(def)).toBe(resolveDialog(def));
  });
});

describe("walking the script", () => {
  it("finds lists and commands by path, and nothing off the end", () => {
    expect(listAt(shop, [])).toBe(shop.script);
    expect(listAt(shop, [2, 0])).toBe(shop.script[2]!.kind === "choices" ? shop.script[2].options[0]!.then : null);
    expect(listAt(shop, [2, 0, 1, 1])).toEqual([say("Fine.")]);
    expect(listAt(shop, [2, 9])).toBeNull();
    expect(commandAt(shop, [2, 0, 1])).toBe(trade);
    expect(commandAt(shop, [2])).toBe(shop.script[2]);
    expect(commandAt(shop, [2, 0])).toBeNull();
    expect(commandAt(shop, [7])).toBeNull();
  });

  it("knows which commands hold blocks, and how many", () => {
    expect(branchesOf(say("x"))).toEqual([]);
    expect(branchesOf(trade)).toHaveLength(2);
    expect(branchesOf(shop.script[2]!)).toHaveLength(2);
  });

  it("replaces a nested list and leaves the rest as it was", () => {
    const next = withListAt(shop, [2, 0, 1, 0], [say("Cheers.")]);
    expect(listAt(next, [2, 0, 1, 0])).toEqual([say("Cheers.")]);
    expect(listAt(next, [2, 0, 1, 1])).toEqual([say("Fine.")]);
    expect(next.script[0]).toBe(shop.script[0]);
    expect(withListAt(shop, [9, 0], [])).toBe(shop);
  });

  it("visits every command root first", () => {
    expect(walkCommands(shop).map((w) => w.path.join("."))).toEqual([
      "0", "1", "2", "2.0.0", "2.0.1", "2.0.1.0.0", "2.0.1.1.0", "2.1.0", "2.1.1",
    ]);
  });

  it("finds an anchor anywhere, first one winning", () => {
    expect(anchorPath(shop, "main")).toEqual([1]);
    expect(anchorPath(shop, "nowhere")).toBeNull();
    const twice: DialogDef = { script: [{ kind: "anchor", name: "a" }, { kind: "anchor", name: "a" }] };
    expect(anchorPath(twice, "a")).toEqual([0]);
    expect(anchorNames(twice)).toEqual(["a"]);
  });

  it("clamps a quantity to the trade's range, opening at its default", () => {
    expect(clampAmount(trade, undefined)).toBe(1);
    expect(clampAmount({ ...trade, default: 3 }, undefined)).toBe(3);
    expect(clampAmount(trade, 9)).toBe(4);
    expect(clampAmount(trade, 2.4)).toBe(2);
  });
});

describe("validating a dialog", () => {
  it("has nothing to say about a sound one", () => {
    expect(validateDialog(shop)).toEqual([]);
  });

  it("warns about an empty script", () => {
    expect(validateDialog({ script: [] }).map((i) => i.severity)).toEqual(["warn"]);
    expect(validateDialog(DEFAULT_DIALOG)).toEqual([]);
  });

  it("errors on a goto with no anchor, and warns about a doubled anchor", () => {
    const issues = validateDialog({
      script: [{ kind: "anchor", name: "a" }, { kind: "anchor", name: "a" }, { kind: "goto", name: "b" }],
    });
    expect(issues).toEqual([
      { severity: "warn", message: expect.stringContaining('"a" appears 2 times') },
      { severity: "error", message: expect.stringContaining('jumps to "b"') },
    ]);
  });

  it("errors on two buttons reading the same, and a blank one", () => {
    const issues = validateDialog({
      script: [{ kind: "choices", options: [{ label: "Yes", then: [] }, { label: "yes", then: [] }, { label: " ", then: [] }] }],
    });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('two buttons reading "yes"'),
      expect.stringContaining("no label"),
    ]);
  });

  it("errors on a trade opening outside its own range", () => {
    const issues = validateDialog({ script: [{ ...trade, default: 9 }] });
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("outside its own range")]);
  });

  it("warns past the depth an outline can follow", () => {
    let command: DialogCommand = say("Deepest.");
    for (let depth = 0; depth <= MAX_DIALOG_DEPTH; depth++) {
      command = { kind: "choices", options: [{ label: "In", then: [command] }] };
    }
    const issues = validateDialog({ script: [command] });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining(`${MAX_DIALOG_DEPTH + 1} blocks deep`),
    ]);
  });

  describe("with a catalogue in hand", () => {
    const potion = tileWith(undefined, "potion", { type: "consumable", hp: 0 });
    const bag = tileWith(undefined, "bag", { type: "container", size: 4, equippable: true });
    const catalogue = { tilesById: { potion, bag }, statusIds: new Set(["luminous"]) };

    it("names ids nothing answers to", () => {
      const dialog: DialogDef = {
        script: [{ ...trade, take: [{ tileId: "shard", count: 1 }] }, { kind: "add_status", statusId: "glowing" }],
      };
      expect(validateDialog(dialog)).toEqual([]);
      expect(validateDialog(dialog, catalogue).map((i) => i.message)).toEqual([
        expect.stringContaining('tile "shard"'),
        expect.stringContaining('status "glowing"'),
      ]);
    });

    it("refuses a container on either side of a trade", () => {
      const issues = validateDialog({ script: [{ ...trade, take: [], give: [{ tileId: "bag", count: 1 }] }] }, catalogue);
      expect(issues).toEqual([{ severity: "error", message: expect.stringContaining("bag, and a container") }]);
    });
  });
});
