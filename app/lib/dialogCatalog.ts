import type { DialogCommand, DialogCommandKind } from "./dialog";

/**
 * The authorable vocabulary of a dialog script, as data the editor reads.
 *
 * The same arrangement `./brainCatalog` makes for a brain, and for the same
 * reason: the runtime knows commands as switch arms and valibot variants —
 * code, which the editor cannot enumerate. This is the same set, turned
 * outward, so the editor's "add a command" picker cannot offer a kind the
 * interpreter does not run. Add an arm to `./dialog` and it stays invisible
 * here until it is added too, which is the right failure: a missing option,
 * not a broken save.
 *
 * `make` takes what a fresh command has to point at, because unlike a brain's
 * "the nearest player" there is no tile or status every world has: the editor
 * hands over the first item tile and the first status it knows, and a world
 * with neither authors a command the lint names.
 */

export type CatalogDefaults = { tileId: string; statusId: string };

type CatalogEntry = {
  label: string;
  /** One-line description shown beside the picker. */
  hint: string;
  make: (defaults: CatalogDefaults) => DialogCommand;
};

export const DIALOG_COMMANDS: Record<DialogCommandKind, CatalogEntry> = {
  say: {
    label: "say",
    hint: "A line from the NPC. {partner} is the player's name.",
    make: () => ({ kind: "say", text: "…" }),
  },
  choices: {
    label: "choices",
    hint: "Buttons for the player, each leading to its own commands. Waits for a press.",
    make: () => ({ kind: "choices", options: [{ label: "Yes", then: [] }, { label: "No", then: [] }] }),
  },
  request_trade: {
    label: "request trade",
    hint: "Offer a trade with a preview and a quantity; Trade runs it and continues one way, Cancel the other.",
    make: ({ tileId }) => ({
      kind: "request_trade",
      take: [{ tileId, count: 1 }],
      give: [],
      min: 1,
      max: 1,
      traded: [],
      cancel: [],
    }),
  },
  anchor: {
    label: "anchor",
    hint: "A named place a goto can come back to — put one before the menu.",
    make: () => ({ kind: "anchor", name: "main" }),
  },
  goto: {
    label: "goto",
    hint: "Continue from just after the anchor of that name, wherever it is.",
    make: () => ({ kind: "goto", name: "main" }),
  },
  add_status: {
    label: "add status",
    hint: "Put a status on the player, for the status's own duration.",
    make: ({ statusId }) => ({ kind: "add_status", statusId }),
  },
  remove_status: {
    label: "remove status",
    hint: "Take a status off the player, if they are under it.",
    make: ({ statusId }) => ({ kind: "remove_status", statusId }),
  },
  tag: {
    label: "tag",
    hint: "Mark the player, so a later check can ask whether this already happened.",
    make: () => ({ kind: "tag", tag: "" }),
  },
};

export const DIALOG_COMMAND_KINDS = Object.keys(DIALOG_COMMANDS) as DialogCommandKind[];
