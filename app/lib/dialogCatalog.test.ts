import { describe, expect, it } from "vitest";
import { resolveDialog } from "./dialog";
import { DIALOG_COMMAND_KINDS, DIALOG_COMMANDS } from "./dialogCatalog";
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
 * the page is something the parser accepts, so a fresh command is never a
 * refused save. `tag` is the deliberate exception — a blank tag is refused
 * until the author types one, and the lint says so.
 */
describe("the dialog catalog", () => {
  it("names every command the interpreter runs, once", () => {
    expect([...DIALOG_COMMAND_KINDS].sort()).toEqual([
      "add_status", "anchor", "choices", "goto", "remove_status", "request_trade", "say", "tag",
    ]);
  });

  it("makes commands the parser accepts, given something to point at", () => {
    for (const kind of DIALOG_COMMAND_KINDS) {
      const made = DIALOG_COMMANDS[kind].make(defaults);
      const command = made.kind === "tag" ? { ...made, tag: "told" } : made;
      const dialog = resolveDialog(tileWith({ script: [command] }));
      expect(dialog?.script[0], kind).toEqual(command);
    }
  });
});
