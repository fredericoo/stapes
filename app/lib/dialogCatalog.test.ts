import { describe, expect, it } from "vitest";
import { resolveDialog } from "./dialog";
import { DIALOG_COMMAND_KINDS, DIALOG_COMMANDS } from "./dialogCatalog";
import { normalizeTileDef } from "./types";
import { FRAME } from "./testTile";

function tileWith(dialog: unknown) {
  return normalizeTileDef({
    id: "seller",
    name: "Seller",
    height: 4,
    directional: false,
    variants: { default: [FRAME] },
    attributes: {},
    kind: "prop",
    interactions: { dialog },
  });
}

const defaults = { tileId: "shard", statusId: "luminous" };

describe("the dialog catalog", () => {
  it("names every command the interpreter runs, once", () => {
    expect([...DIALOG_COMMAND_KINDS].sort()).toEqual([
      "add_status",
      "anchor",
      "choices",
      "goto",
      "remove_status",
      "request_trade",
      "say",
      "tag",
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
