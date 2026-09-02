import { describe, expect, it } from "vitest";
import { DEFAULT_DIALOG, resolveDialog } from "./dialog";
import {
  DIALOG_CONDITION_NAMES,
  DIALOG_CONDITIONS,
  DIALOG_EFFECT_NAMES,
  DIALOG_EFFECTS,
} from "./dialogCatalog";
import { normalizeTileDef } from "./types";

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tileWith(dialog: unknown) {
  return normalizeTileDef({
    id: "seller",
    name: "Seller",
    height: 4,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "prop",
    interactions: { dialog },
  });
}

const defaults = { tileId: "shard", statusId: "luminous" };

/**
 * The one test that matters for a catalog: everything the editor can put on
 * the page is something the parser accepts, so a fresh entry is never a
 * refused save. The `has_tag` and `tag` entries are the deliberate exception —
 * a blank tag is refused until the author types one, and the lint says so.
 */
describe("the dialog catalog", () => {
  it("names every condition and effect the runtime knows, once", () => {
    expect(DIALOG_CONDITION_NAMES.sort()).toEqual(["carries", "has_status", "has_tag", "room_for"]);
    expect(DIALOG_EFFECT_NAMES.sort()).toEqual(["add_status", "tag", "trade"]);
  });

  it("makes conditions the parser accepts, given something to point at", () => {
    for (const name of DIALOG_CONDITION_NAMES) {
      const made = DIALOG_CONDITIONS[name].make(defaults);
      const leaf = made.cond === "has_tag" ? { ...made, tag: "told" } : made;
      const dialog = resolveDialog(
        tileWith({ ...DEFAULT_DIALOG, options: [{ label: "x", say: "x", if: leaf }] }),
      );
      expect(dialog?.options[0]?.if, name).toEqual(leaf);
    }
  });

  it("makes effects the parser accepts, given something to point at", () => {
    for (const name of DIALOG_EFFECT_NAMES) {
      const made = DIALOG_EFFECTS[name].make(defaults);
      const effect = made.effect === "tag" ? { ...made, tag: "told" } : made;
      const dialog = resolveDialog(
        tileWith({ ...DEFAULT_DIALOG, options: [{ label: "x", say: "x", do: [effect] }] }),
      );
      expect(dialog?.options[0]?.do, name).toEqual([effect]);
    }
  });
});
