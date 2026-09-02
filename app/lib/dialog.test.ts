import { describe, expect, it } from "vitest";
import {
  clampAmount,
  DEFAULT_DIALOG,
  MAX_DIALOG_DEPTH,
  optionAt,
  optionsAt,
  resolveDialog,
  validateDialog,
  type DialogDef,
  type DialogOption,
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

function tileWith(dialog: unknown, id = "seller") {
  return normalizeTileDef({
    id,
    name: id,
    height: 4,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "prop",
    interactions: dialog === undefined ? {} : { dialog },
  });
}

const shop: DialogDef = {
  opening: "Hello, {partner}.",
  options: [
    { label: "Recipe", say: "Ten crystals, one solution." },
    {
      label: "Buy a potion",
      say: "Fourteen shards. Deal?",
      then: [
        { label: "Yes", say: "Here.", else: "No." },
        { label: "No", say: "Suit yourself." },
      ],
    },
  ],
};

describe("resolving a dialog", () => {
  it("parses a block and trims its labels", () => {
    const dialog = resolveDialog(
      tileWith({ ...shop, options: [{ label: "  Recipe ", say: "x" }] }),
    );
    expect(dialog?.options[0]?.label).toBe("Recipe");
  });

  it("is null for a tile with no dialog", () => {
    expect(resolveDialog(tileWith(undefined))).toBeNull();
  });

  it("is null for a blank opening line", () => {
    expect(resolveDialog(tileWith({ ...shop, opening: "" }))).toBeNull();
  });

  it("is null for an option with no label or no line", () => {
    expect(resolveDialog(tileWith({ ...shop, options: [{ label: " ", say: "x" }] }))).toBeNull();
    expect(resolveDialog(tileWith({ ...shop, options: [{ label: "x", say: "" }] }))).toBeNull();
  });

  it("parses a condition tree, an effect list, and an amount", () => {
    const dialog = resolveDialog(
      tileWith({
        ...shop,
        options: [
          {
            label: "Sell bottles",
            amount: { min: 1, max: 12 },
            if: { combinator: "and", rules: [{ cond: "carries", tileId: "bottle", count: 1 }, { cond: "room_for", tileId: "shard", count: 2 }] },
            do: [
              { effect: "trade", take: [{ tileId: "bottle", count: 1 }], give: [{ tileId: "shard", count: 2 }] },
              { effect: "add_status", statusId: "luminous" },
              { effect: "tag", tag: "customer" },
            ],
            say: "Ta.",
            else: "No.",
          },
        ],
      }),
    );
    expect(dialog?.options[0]?.do).toHaveLength(3);
    expect(dialog?.options[0]?.amount).toEqual({ min: 1, max: 12 });
  });

  it("refuses a trade of nothing for nothing, a count of nothing, and an inverted amount", () => {
    const bad = (option: Record<string, unknown>) =>
      resolveDialog(tileWith({ ...shop, options: [{ label: "x", say: "x", ...option }] }));
    expect(bad({ do: [{ effect: "trade", take: [], give: [] }] })).toBeNull();
    expect(bad({ if: { cond: "carries", tileId: "shard", count: 0 } })).toBeNull();
    expect(bad({ amount: { min: 3, max: 2 } })).toBeNull();
  });

  it("is memoised on the def", () => {
    const def = tileWith(shop);
    expect(resolveDialog(def)).toBe(resolveDialog(def));
  });
});

describe("walking the tree", () => {
  it("finds an option by path, and nothing off the end", () => {
    expect(optionAt(shop, [1, 0])?.label).toBe("Yes");
    expect(optionAt(shop, [1, 5])).toBeNull();
    expect(optionAt(shop, [0, 0])).toBeNull();
  });

  it("offers the root at the root, and a reply's follow-ups under it", () => {
    expect(optionsAt(shop, []).map((o) => o.label)).toEqual(["Recipe", "Buy a potion"]);
    expect(optionsAt(shop, [1]).map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  it("offers the root again under a reply with no follow-ups", () => {
    expect(optionsAt(shop, [0])).toBe(shop.options);
    expect(optionsAt(shop, [1, 0])).toBe(shop.options);
  });

  it("clamps an amount to the author's range, and reads one where there is none", () => {
    const counted: DialogOption = { label: "x", say: "x", amount: { min: 2, max: 5 } };
    expect(clampAmount(counted, undefined)).toBe(2);
    expect(clampAmount(counted, 9)).toBe(5);
    expect(clampAmount(counted, 3.4)).toBe(3);
    expect(clampAmount({ label: "x", say: "x" }, 7)).toBe(1);
  });
});

describe("validating a dialog", () => {
  it("has nothing to say about a sound one", () => {
    expect(validateDialog(shop)).toEqual([]);
  });

  it("warns about a dialog with no options", () => {
    expect(validateDialog(DEFAULT_DIALOG).map((i) => i.severity)).toEqual(["warn"]);
  });

  it("warns when two buttons at one level read the same", () => {
    const issues = validateDialog({
      ...shop,
      options: [{ label: "Yes", say: "a" }, { label: "yes", say: "b" }],
    });
    expect(issues).toEqual([
      { severity: "warn", message: expect.stringContaining('"yes" appears twice') },
    ]);
  });

  it("does not mind the same button under two different replies", () => {
    expect(validateDialog(shop)).toEqual([]);
  });

  it("errors on a blank line, which the schema would refuse", () => {
    const issues = validateDialog({ ...shop, options: [{ label: "x", say: "  " }] });
    expect(issues).toEqual([{ severity: "error", message: "option 1 says nothing" }]);
  });

  it("warns about an option that can refuse and has nothing to say about it", () => {
    const issues = validateDialog({
      ...shop,
      options: [{ label: "x", say: "x", if: { cond: "has_tag", tag: "t" } }],
    });
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("no else line")]);
  });

  it("warns about a stepper with nothing to multiply", () => {
    const issues = validateDialog({
      ...shop,
      options: [{ label: "x", say: "x", amount: { min: 1, max: 3 } }],
    });
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("nothing counted")]);
  });

  it("warns past the depth a conversation can follow", () => {
    let option: DialogOption = { label: "deep", say: "Deepest." };
    for (let depth = 0; depth < MAX_DIALOG_DEPTH; depth++) {
      option = { label: "deep", say: "Deeper.", then: [option] };
    }
    const issues = validateDialog({ ...shop, options: [option] });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining(`${MAX_DIALOG_DEPTH + 1} deep`),
    ]);
  });

  describe("with a catalogue in hand", () => {
    const potion = tileWith(undefined, "potion");
    const bag = normalizeTileDef({
      id: "bag",
      name: "Bag",
      height: 0,
      directional: false,
      variants: { default: [frame] },
      attributes: {},
      kind: "item",
      interactions: { item: { type: "container", size: 4, equippable: true } },
    });
    const catalogue = { tilesById: { potion, bag }, statusIds: new Set(["luminous"]) };

    it("names ids nothing answers to", () => {
      const dialog: DialogDef = {
        ...shop,
        options: [
          {
            label: "x",
            say: "x",
            else: "no",
            if: { cond: "carries", tileId: "shard", count: 1 },
            do: [{ effect: "add_status", statusId: "glowing" }],
          },
        ],
      };
      expect(validateDialog(dialog)).toEqual([]);
      expect(validateDialog(dialog, catalogue).map((i) => i.message)).toEqual([
        expect.stringContaining('tile "shard"'),
        expect.stringContaining('status "glowing"'),
      ]);
    });

    it("refuses a container on either side of a trade", () => {
      const issues = validateDialog(
        {
          ...shop,
          options: [{ label: "x", say: "x", else: "no", do: [{ effect: "trade", take: [], give: [{ tileId: "bag", count: 1 }] }] }],
        },
        catalogue,
      );
      expect(issues).toEqual([
        { severity: "error", message: expect.stringContaining("Bag, and a container") },
      ]);
    });
  });
});
