import type { DialogConditionDef, DialogEffectDef } from "./dialog";

/**
 * The authorable vocabulary of a dialog, as data the editor reads.
 *
 * The same arrangement `./brainCatalog` makes for a brain, and for the same
 * reason: the runtime knows conditions and effects as switch arms and valibot
 * variants — code, which the editor cannot enumerate. This is the same set,
 * turned outward, so the editor's pickers cannot offer a name the runtime does
 * not implement. Add a verb to `./dialog` and it stays invisible here until it
 * is added too, which is the right failure: a missing option, not a broken
 * save.
 *
 * `make` takes what a fresh entry has to point at, because unlike a brain's
 * "the nearest player" there is no tile or status every world has: the editor
 * hands over the first item tile and the first status it knows, and a world
 * with neither authors an entry the lint names.
 */

export type CatalogDefaults = { tileId: string; statusId: string };

type CatalogEntry<T> = {
  label: string;
  /** One-line description shown beside the picker. */
  hint: string;
  make: (defaults: CatalogDefaults) => T;
};

export const DIALOG_CONDITIONS: Record<
  DialogConditionDef["cond"],
  CatalogEntry<DialogConditionDef>
> = {
  carries: {
    label: "carries",
    hint: "The partner has at least this many of a tile on them, piles summed, bags in hands included.",
    make: ({ tileId }) => ({ cond: "carries", tileId, count: 1 }),
  },
  room_for: {
    label: "has room for",
    hint: "There is somewhere on the partner for this many of a tile, on a trade's landing rule.",
    make: ({ tileId }) => ({ cond: "room_for", tileId, count: 1 }),
  },
  has_tag: {
    label: "has tag",
    hint: "The partner holds a tag — a reward's, or one a tag effect wrote.",
    make: () => ({ cond: "has_tag", tag: "" }),
  },
  has_status: {
    label: "has status",
    hint: "The partner is under this status right now.",
    make: ({ statusId }) => ({ cond: "has_status", statusId }),
  },
};

export const DIALOG_CONDITION_NAMES = Object.keys(
  DIALOG_CONDITIONS,
) as DialogConditionDef["cond"][];

export const DIALOG_EFFECTS: Record<
  DialogEffectDef["effect"],
  CatalogEntry<DialogEffectDef>
> = {
  trade: {
    label: "trade",
    hint: "Take these from the partner and give them those — all or nothing, nothing on the floor. Either side may be empty.",
    make: ({ tileId }) => ({ effect: "trade", take: [{ tileId, count: 1 }], give: [] }),
  },
  add_status: {
    label: "add status",
    hint: "Put a status on the partner, for the status's own duration.",
    make: ({ statusId }) => ({ effect: "add_status", statusId }),
  },
  tag: {
    label: "tag",
    hint: "Mark the partner, so a later 'has tag' can ask whether this already happened.",
    make: () => ({ effect: "tag", tag: "" }),
  },
};

export const DIALOG_EFFECT_NAMES = Object.keys(
  DIALOG_EFFECTS,
) as DialogEffectDef["effect"][];
