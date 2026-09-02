import * as v from "valibot";
import { conditionSchema, conditionLeaves, type ConditionNode } from "./conditions";
import { resolveContainer } from "./item";
import type { TileDef } from "./types";

/**
 * A conversation an NPC can hold, authored as a tree of options.
 *
 * ## The shape of a talk
 *
 * A player presses *Talk* on a body, a panel opens with the NPC's `opening`
 * line and a button per root option, and every press answers with that
 * option's `say` and its own `then` buttons — or, for a reply with none, only
 * *Back*. *Back* goes up one level; *Close* ends it. It is read as a tree:
 * under a reply are that reply's follow-ups and nothing else, so a branch is
 * as deep as the author made it. Nothing is typed: what an NPC can be asked
 * is what is on the buttons, which is the whole of its discoverability and
 * the whole of why it works on a phone.
 *
 * This replaced typed keywords. The brain already hears (`heard`) and talks
 * (`say`) and the `shopkeeper` holds a hi/bye conversation on nothing else,
 * but a keyword an NPC answers to is a keyword a player has to guess, and a
 * chat bar is the worst control a thumb has. The tree, the conditions and the
 * effects are exactly what they were; only the way a branch is chosen moved
 * from the ear to the finger.
 *
 * ## Many at once
 *
 * A conversation is the *player's* state, not the NPC's, so any number of
 * people can be talking to one salesman and none of them sees the others'
 * panels. What the NPC knows is only whether anybody is — the brain condition
 * `talking` — so it can stand still for a sale.
 *
 * ## Options that ask and do
 *
 * An option may carry an `if` (asked of the partner: what they carry, whether
 * there is room, a tag, a status), a `do` (a trade, a status, a tag — all or
 * none), and an `else` said instead when either refuses. A refusal is a leaf
 * like any other answer: only *Back*. An `amount` makes the option a question
 * first — the NPC asks how many, a stepper answers — and multiplies every
 * count in the option's trade and conditions by the number confirmed.
 *
 * Parsed with valibot and memoised on def identity, on the same trust model
 * as every other interaction block: a malformed dialog is a body with no Talk
 * row, never a crashed world.
 */

/**
 * A question about the partner, asked before an option answers.
 *
 * All about the partner's kit and record, and nothing about time or distance:
 * reach is the Talk row's own rule. Composed with `and`/`or`/`not` by
 * `./conditions`, which was written expecting a second vocabulary — this is it.
 */
export type DialogConditionDef =
  /** At least `count` of a tile across everything carried, piles summed. */
  | { cond: "carries"; tileId: string; count: number }
  /** Somewhere on the body for `count` of a tile, on a trade's landing rule. */
  | { cond: "room_for"; tileId: string; count: number }
  /** The partner holds a tag — a reward's, or one a `tag` effect wrote. */
  | { cond: "has_tag"; tag: string }
  /** The partner is under a status right now. */
  | { cond: "has_status"; statusId: string };

export type DialogCondition = ConditionNode<DialogConditionDef>;

/** So many of one tile, as one side of a trade. */
export type TradeSide = { tileId: string; count: number };

/**
 * Something an option does when it answers.
 *
 * Every one of these can be refused — a trade short on either side, a status
 * nobody authored — and a refusal reads exactly as the option's `if` failing:
 * the `else` line is said and nothing changes. A list is a transaction: all of
 * it runs or none of it does.
 */
export type DialogEffectDef =
  /**
   * Take these from the partner and give them those, or neither.
   *
   * Either side may be empty — a gift, or a fee — but not both. Never a
   * container on either side: a pack is not a thing you spend, and a trade that
   * handed one over would be a second inventory arriving somewhere nothing
   * nests. See `../game/trade`.
   */
  | { effect: "trade"; take: TradeSide[]; give: TradeSide[] }
  /** Put a status on the partner, for the status's own duration. */
  | { effect: "add_status"; statusId: string }
  /** Mark the partner, on a reward tag's terms, so `has_tag` can ask later. */
  | { effect: "tag"; tag: string };

/**
 * A quantity asked for before the option does anything.
 *
 * Pressing an option with an amount does not run it: the NPC asks `prompt`,
 * the panel shows a stepper and a `confirm` button, and only the confirm runs
 * the option's `if` and `do` with every `count` in them multiplied by the
 * chosen number — so one authored price covers "one bottle" and "all nine".
 * Two steps rather than a stepper beside the button, because "how many" is a
 * question the NPC asks, and a tree of questions is what this is.
 */
export type DialogAmount = {
  min: number;
  max: number;
  /** What the NPC says while asking. `{partner}` is filled. */
  prompt: string;
  /** The confirm button. Absent reads "Confirm". */
  confirm?: string;
};

/** What an amount's confirm button says when the author left it blank. */
export const DEFAULT_CONFIRM_LABEL = "Confirm";

export type DialogOption = {
  /** The button. Short — it is a button. */
  label: string;
  /** Asked of the partner first. Failing it says `else` instead. */
  if?: DialogCondition;
  /** Run when `if` holds, all or nothing. Refused says `else` instead. */
  do?: DialogEffectDef[];
  /** What the NPC says when this is pressed and allowed. `{partner}` is filled. */
  say: string;
  /** Said instead of `say` when `if` failed or `do` was refused. */
  else?: string;
  /** A quantity the NPC asks for before this runs. @see DialogAmount */
  amount?: DialogAmount;
  /** The buttons shown after this reply, instead of the root's. */
  then?: DialogOption[];
};

export type DialogDef = {
  /** What the NPC says when the panel opens. `{partner}` is filled. */
  opening: string;
  options: DialogOption[];
};

/**
 * How deep `then` may nest before the editor says something.
 *
 * A warning rather than a refusal: nothing breaks at four, but a conversation
 * four presses deep before *Back* is one a player cannot hold in their head,
 * and the outline that authored it will not fit on a screen either.
 */
export const MAX_DIALOG_DEPTH = 3;

/**
 * The most of anything one press may move.
 *
 * A sanity bound on the amount stepper's ceiling, on the terms `MAX_PILE` is:
 * two digits is more bottles than anybody is carrying, and a typo'd third
 * reads as malformed rather than as a shop that buys a thousand.
 */
export const MAX_DIALOG_AMOUNT = 99;

/** What a fresh dialog block says, so the editor has something to show. */
export const DEFAULT_DIALOG: DialogDef = {
  opening: "Hello, {partner}.",
  options: [],
};

const tileId = v.pipe(v.string(), v.trim(), v.minLength(1));

// At least one: a condition about zero of something is always true and never
// what anybody typed.
const count = v.pipe(v.number(), v.integer(), v.minValue(1));

const line = v.pipe(v.string(), v.minLength(1));

const conditionLeafSchema = v.variant("cond", [
  v.object({ cond: v.literal("carries"), tileId, count }),
  v.object({ cond: v.literal("room_for"), tileId, count }),
  v.object({ cond: v.literal("has_tag"), tag: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
  v.object({ cond: v.literal("has_status"), statusId: tileId }),
]);

const ifSchema = conditionSchema<DialogConditionDef>(conditionLeafSchema);

const tradeSideSchema = v.object({ tileId, count });

const effectSchema = v.variant("effect", [
  v.pipe(
    v.object({
      effect: v.literal("trade"),
      take: v.array(tradeSideSchema),
      give: v.array(tradeSideSchema),
    }),
    // A trade of nothing for nothing is an option that should not have a trade.
    v.check((raw) => raw.take.length + raw.give.length > 0, "a trade moves something"),
  ),
  v.object({ effect: v.literal("add_status"), statusId: tileId }),
  v.object({ effect: v.literal("tag"), tag: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
]);

const amountSchema = v.pipe(
  v.object({
    min: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DIALOG_AMOUNT)),
    max: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DIALOG_AMOUNT)),
    prompt: line,
    confirm: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  }),
  v.check((raw) => raw.max >= raw.min, "an amount's ceiling is at least its floor"),
);

// Recursive through `then`, the way `./conditions` is through `rules`: an
// option holds options, and valibot needs to be told the type it will arrive at.
const optionSchema: v.GenericSchema<unknown, DialogOption> = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
  if: v.optional(ifSchema),
  do: v.optional(v.array(effectSchema)),
  say: line,
  else: v.optional(line),
  amount: v.optional(amountSchema),
  then: v.optional(v.array(v.lazy(() => optionSchema))),
});

const dialogSchema = v.object({
  opening: line,
  options: v.array(optionSchema),
});

const dialogCache = new WeakMap<TileDef, DialogDef | null>();

/**
 * Parsed dialog for a tile def, or null when it has none or it is malformed.
 *
 * Memoised on def identity like every other resolver, because the option list
 * asks this of every body in view on every frame.
 */
export function resolveDialog(def: TileDef): DialogDef | null {
  const cached = dialogCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.dialog;
  const parsed = raw == null ? null : v.safeParse(dialogSchema, raw);
  const dialog = parsed?.success ? parsed.output : null;
  dialogCache.set(def, dialog);
  return dialog;
}

/**
 * The option a path names, or null when the def has none there.
 *
 * A path is indices from the root, one per `then` descended — see
 * `../game/dialogRuntime`'s `Conversation`. Shared by the runtime, which
 * follows it, and the panel, which draws the buttons at its end.
 */
export function optionAt(
  dialog: DialogDef,
  path: readonly number[],
): DialogOption | null {
  let options: readonly DialogOption[] = dialog.options;
  let found: DialogOption | null = null;
  for (const index of path) {
    found = options[index] ?? null;
    if (!found) return null;
    options = found.then ?? [];
  }
  return found;
}

/**
 * The buttons under a path: the root's at the root, and otherwise that
 * reply's own `then` — which is nothing for a reply with no follow-ups.
 *
 * Nothing rather than the root, because this is a tree: a reply with nothing
 * under it is a leaf, and the way out of a leaf is *Back*. Offering the root
 * again under every reply would make every branch one press deep.
 */
export function optionsAt(
  dialog: DialogDef,
  path: readonly number[],
): readonly DialogOption[] {
  if (path.length === 0) return dialog.options;
  return optionAt(dialog, path)?.then ?? [];
}

/**
 * The amount an option may be pressed with, or one where it has no stepper.
 *
 * Clamped rather than refused, because the client's stepper and the server's
 * check are two readings of one authored range and a press one over the edge
 * is a race, not an attack.
 */
export function clampAmount(option: DialogOption, requested: number | undefined): number {
  if (!option.amount) return 1;
  const wanted = Math.round(requested ?? option.amount.min);
  return Math.min(option.amount.max, Math.max(option.amount.min, wanted));
}

/** One thing wrong with a dialog, at the level the editor should say it. */
export type DialogIssue = { severity: "error" | "warn"; message: string };

/**
 * What a dialog's ids may point at, when the caller has the catalogues.
 *
 * Optional, because the shape can be checked without them and the editor may
 * not have both to hand; given, an id nothing answers to is an error rather
 * than a silent no-op at play time.
 */
export type DialogCatalogue = {
  tilesById: Record<string, TileDef>;
  statusIds: ReadonlySet<string>;
};

/**
 * Everything true of a dialog that its shape alone cannot say, as a list.
 *
 * The same contract `validateBrain` keeps: errors are what would make the block
 * fail to parse — said here in words, because the editor holds a draft and a
 * schema failure names a path rather than a problem — and warnings are things
 * that parse and are almost certainly not what the author meant.
 */
export function validateDialog(
  dialog: DialogDef,
  catalogue?: DialogCatalogue,
): DialogIssue[] {
  const issues: DialogIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const warn = (message: string) => issues.push({ severity: "warn", message });

  if (dialog.opening.trim() === "") error("The opening line is blank");
  if (dialog.options.length === 0) warn("No options: this body opens its mouth and offers nothing to press");

  checkOptions(dialog.options, "option", 1, error, warn, catalogue);
  return issues;
}

/**
 * Walk a level of options, then each one's `then`.
 *
 * A duplicate label is reported at the level it is on: two "Yes" buttons under
 * one reply are two buttons nobody can tell apart, where "Yes" under two
 * different replies is two perfectly good answers to two different questions.
 */
function checkOptions(
  options: readonly DialogOption[],
  where: string,
  depth: number,
  error: (message: string) => void,
  warn: (message: string) => void,
  catalogue?: DialogCatalogue,
) {
  const seen = new Set<string>();
  options.forEach((option, index) => {
    const name = `${where} ${index + 1}`;
    if (option.label.trim() === "") error(`${name} has no label`);
    if (option.say.trim() === "") error(`${name} says nothing`);
    const label = option.label.trim().toLowerCase();
    if (seen.has(label)) warn(`"${option.label}" appears twice among the same buttons`);
    seen.add(label);
    checkOptionRules(option, name, error, warn, catalogue);
    if (!option.then?.length) return;
    if (depth >= MAX_DIALOG_DEPTH) {
      warn(`${name} nests replies ${depth + 1} deep; ${MAX_DIALOG_DEPTH} is as far as a conversation can follow`);
    }
    checkOptions(option.then, `${name} reply`, depth + 1, error, warn, catalogue);
  });
}

/**
 * What an option's condition, effects and amount point at, and whether they
 * can.
 *
 * An option that asks a question and has no `else` is the one warning here
 * worth explaining: a failed `if` then says nothing, and a button that does
 * nothing when pressed reads as broken.
 */
function checkOptionRules(
  option: DialogOption,
  name: string,
  error: (message: string) => void,
  warn: (message: string) => void,
  catalogue?: DialogCatalogue,
) {
  if ((option.if || option.do?.length) && !option.else) {
    warn(`${name} can refuse but has no else line, so a refusal says nothing`);
  }
  if (option.else !== undefined && option.else.trim() === "") {
    error(`${name} has a blank else line; leave it out to say nothing`);
  }
  if (option.amount && option.amount.max < option.amount.min) {
    error(`${name} has an amount whose ceiling is below its floor`);
  }
  if (option.amount && option.amount.prompt.trim() === "") {
    error(`${name} asks for an amount without saying so`);
  }
  if (option.amount && countedIn(option) === 0) {
    warn(`${name} has an amount stepper but nothing counted for it to multiply`);
  }
  for (const effect of option.do ?? []) {
    if (effect.effect !== "trade") continue;
    if (effect.take.length + effect.give.length === 0) {
      error(`${name} trades nothing for nothing`);
    }
    for (const side of [...effect.take, ...effect.give]) {
      const def = catalogue?.tilesById[side.tileId];
      if (def && resolveContainer(def)) {
        error(`${name} trades ${def.name}, and a container is not a thing a trade may move`);
      }
    }
  }
  if (!catalogue) return;
  for (const id of tileIdsOf(option)) {
    if (!catalogue.tilesById[id]) error(`${name} names a tile "${id}" the catalogue does not hold`);
  }
  for (const id of statusIdsOf(option)) {
    if (!catalogue.statusIds.has(id)) error(`${name} names a status "${id}" nobody authored`);
  }
}

/** How many counted things — trade sides and counted conditions — an option has. */
function countedIn(option: DialogOption): number {
  let counted = 0;
  for (const leaf of option.if ? conditionLeaves(option.if) : []) {
    if (leaf.cond === "carries" || leaf.cond === "room_for") counted++;
  }
  for (const effect of option.do ?? []) {
    if (effect.effect === "trade") counted += effect.take.length + effect.give.length;
  }
  return counted;
}

function tileIdsOf(option: DialogOption): string[] {
  const ids: string[] = [];
  for (const leaf of option.if ? conditionLeaves(option.if) : []) {
    if (leaf.cond === "carries" || leaf.cond === "room_for") ids.push(leaf.tileId);
  }
  for (const effect of option.do ?? []) {
    if (effect.effect !== "trade") continue;
    for (const side of [...effect.take, ...effect.give]) ids.push(side.tileId);
  }
  return ids;
}

function statusIdsOf(option: DialogOption): string[] {
  const ids: string[] = [];
  for (const leaf of option.if ? conditionLeaves(option.if) : []) {
    if (leaf.cond === "has_status") ids.push(leaf.statusId);
  }
  for (const effect of option.do ?? []) {
    if (effect.effect === "add_status") ids.push(effect.statusId);
  }
  return ids;
}
