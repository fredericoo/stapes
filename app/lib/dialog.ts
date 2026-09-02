import * as v from "valibot";
import { conditionSchema, conditionLeaves, type ConditionNode } from "./conditions";
import { resolveContainer } from "./item";
import type { TileDef } from "./types";

/**
 * A conversation an NPC can hold, authored as a tree of topics.
 *
 * ## Why this is not more brain
 *
 * The brain already hears (`heard`), remembers who spoke (`speaker`, `bind`)
 * and talks (`say`), and the `shopkeeper` in `data/tiles.json` holds a whole
 * hi → talking → bye conversation on nothing else. What it cannot do well is
 * *scale*: every reply is a state, every state needs an `after` transition
 * back, and every `heard` needs the same `from: is partner` filter copied onto
 * it. Ten topics is thirty rows in a first-match-wins table that also drives
 * the legs. The brain stays the body's mind; this is its mouth.
 *
 * ## Three rules
 *
 * - **Topics are an ordered list, and the first match wins** — the brain's own
 *   rule, for the same reason: order is the only way to say "potion" beats
 *   "buy" when both are in the sentence, and an editor can make order loud.
 * - **A keyword matches as a whole word**, case-insensitively. The brain's
 *   `heard` is a substring on purpose — a cat answering "ps" inside "psps" —
 *   but a shop answering "potion" inside "emotion" is a shop that mishears.
 * - **One partner at a time.** Whoever greets first is answered until they say
 *   bye, fall silent for `idleMs`, or leave earshot; anybody else greeting in
 *   the meantime hears the `busy` line. This is the arrangement the shopkeeper
 *   already keeps, and the one a queue at a counter actually has.
 *
 * ## Shape
 *
 * `greet` opens a conversation and `bye` closes one; both are a line with the
 * words that trigger it. Between them, `topics`: each is the words it answers
 * to, the line it says, and optionally `then` — the topics that are live *right
 * after* that reply, so "Deal?" can be followed by "yes" without "yes" meaning
 * anything the rest of the time. A `then` branch is one exchange deep: the next
 * thing said that matches nothing in it falls through to the root topics.
 *
 * `{partner}` in any line is the name of whoever the NPC is talking to, filled
 * on the terms a brain's `{slot}` is — see `../game/dialogRuntime`.
 *
 * Parsed with valibot and memoised on def identity, on the same trust model as
 * every other interaction block: a malformed dialog is a mute NPC, never a
 * crashed world.
 */

/** A line and the words that trigger it — what `greet` and `bye` are. */
export type DialogLine = {
  /** Whole words, lowercased on the way in. At least one. */
  hear: string[];
  say: string;
};

/**
 * A question about the partner, asked before a topic answers.
 *
 * All about the partner's kit and record, and nothing about time or distance:
 * those are the brain's, and ending a conversation on distance is the block's
 * own `cells`. Composed with `and`/`or`/`not` by `./conditions`, which was
 * written expecting a second vocabulary — this is it.
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
 * Something a topic does when it answers.
 *
 * Every one of these can be refused — a trade short on either side, a status
 * nobody authored — and a refusal reads exactly as the topic's `if` failing:
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

export type DialogTopic = DialogLine & {
  /** Asked of the partner first. Failing it says `else` instead. */
  if?: DialogCondition;
  /** Run when `if` holds, all or nothing. Refused says `else` instead. */
  do?: DialogEffectDef[];
  /** Said instead of `say` when `if` failed or `do` was refused. */
  else?: string;
  /** Topics live only right after this reply. Absent or empty means none. */
  then?: DialogTopic[];
};

export type DialogDef = {
  /** Earshot, in plan steps — the same meaning the brain's `heard.cells` has. */
  cells: number;
  /** Also demand a clear line of sight, like `heard.los`. */
  los?: boolean;
  /** The partner saying nothing for this long ends the conversation, silently. */
  idleMs: number;
  greet: DialogLine;
  /** Said once to somebody else who greets mid-conversation. Absent is silence. */
  busy?: string;
  bye: DialogLine;
  topics: DialogTopic[];
};

/**
 * How deep `then` may nest before the editor says something.
 *
 * A warning rather than a refusal: nothing breaks at four, but a conversation
 * four replies deep before it falls back to the root is one a player cannot
 * hold in their head, and the outline that authored it will not fit on a
 * screen either.
 */
export const MAX_DIALOG_DEPTH = 3;

/** What a fresh dialog block says, so the editor has something to show. */
export const DEFAULT_DIALOG: DialogDef = {
  cells: 4,
  los: true,
  idleMs: 30_000,
  greet: { hear: ["hi", "hello"], say: "Hello, {partner}." },
  busy: "One moment, I'm with {partner}.",
  bye: { hear: ["bye"], say: "See you, {partner}." },
  topics: [],
};

/**
 * A keyword as it is compared: lowercase, trimmed, one space between words.
 *
 * Applied by the schema so a hand-authored "Potion " and a typed "potion" are
 * one keyword, and applied again by the matcher to the utterance so both sides
 * of the comparison have been through the same hands.
 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

const WORD_CHAR = /[a-z0-9]/;

/**
 * Does this utterance contain this keyword as a whole word?
 *
 * Whole-word rather than substring — see the module note — and by scanning
 * rather than a regex, so a keyword is never a pattern: an author who writes
 * "c++" or "1.5" gets those characters and not a syntax error at match time.
 * A keyword may be several words; "empty bottle" matches as the phrase.
 */
export function hearsWord(utterance: string, keyword: string): boolean {
  const haystack = normalizeKeyword(utterance);
  if (keyword.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(keyword, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = haystack[at + keyword.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

/** Does this utterance contain any of these keywords as a whole word? */
export function hearsAny(utterance: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => hearsWord(utterance, keyword));
}

const keywordSchema = v.pipe(
  v.string(),
  v.transform(normalizeKeyword),
  v.minLength(1),
);

const hearSchema = v.pipe(v.array(keywordSchema), v.minLength(1));

const lineSchema = v.pipe(v.string(), v.minLength(1));

const dialogLineSchema = v.object({ hear: hearSchema, say: lineSchema });

const tileId = v.pipe(v.string(), v.trim(), v.minLength(1));

// At least one: a condition about zero of something is always true and never
// what anybody typed.
const count = v.pipe(v.number(), v.integer(), v.minValue(1));

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
    // A trade of nothing for nothing is a topic that should not have a trade.
    v.check((raw) => raw.take.length + raw.give.length > 0, "a trade moves something"),
  ),
  v.object({ effect: v.literal("add_status"), statusId: tileId }),
  v.object({ effect: v.literal("tag"), tag: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
]);

// Recursive through `then`, the way `./conditions` is through `rules`: a topic
// holds topics, and valibot needs to be told the type it will arrive at.
const topicSchema: v.GenericSchema<unknown, DialogTopic> = v.object({
  hear: hearSchema,
  say: lineSchema,
  if: v.optional(ifSchema),
  do: v.optional(v.array(effectSchema)),
  else: v.optional(lineSchema),
  then: v.optional(v.array(v.lazy(() => topicSchema))),
});

const dialogSchema = v.object({
  cells: v.pipe(v.number(), v.integer(), v.minValue(0)),
  los: v.optional(v.boolean()),
  idleMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  greet: dialogLineSchema,
  busy: v.optional(lineSchema),
  bye: dialogLineSchema,
  topics: v.array(topicSchema),
});

const dialogCache = new WeakMap<TileDef, DialogDef | null>();

/**
 * Parsed dialog for a tile def, or null when it has none or it is malformed.
 *
 * Memoised on def identity like every other resolver, because the session asks
 * this for every resident on every brain tick.
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

  checkLine(dialog.greet, "greeting", error);
  checkLine(dialog.bye, "farewell", error);
  if (dialog.busy !== undefined && dialog.busy.trim() === "") {
    error("The busy line is blank; leave it out to say nothing");
  }
  if (dialog.cells === 0) warn("Earshot is 0 cells, so only somebody standing on this body is heard");
  if (dialog.topics.length === 0) warn("No topics: this body greets and says goodbye, and nothing between");

  const shared = dialog.greet.hear.filter((word) => dialog.bye.hear.includes(word));
  for (const word of shared) {
    warn(`"${word}" both greets and says goodbye, so saying it starts and ends the conversation`);
  }

  checkTopics(dialog.topics, "topic", 1, error, warn, catalogue);
  return issues;
}

/**
 * What a topic's condition and effects point at, and whether they can.
 *
 * A topic that asks a question and has no `else` is the one warning here worth
 * explaining: a failed `if` then says nothing, and nothing is indistinguishable
 * from the word not having been heard.
 */
function checkTopicRules(
  topic: DialogTopic,
  name: string,
  error: (message: string) => void,
  warn: (message: string) => void,
  catalogue?: DialogCatalogue,
) {
  if ((topic.if || topic.do?.length) && !topic.else) {
    warn(`${name} can refuse but has no else line, so a refusal says nothing`);
  }
  if (topic.else !== undefined && topic.else.trim() === "") {
    error(`${name} has a blank else line; leave it out to say nothing`);
  }
  for (const effect of topic.do ?? []) {
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
  for (const id of tileIdsOf(topic)) {
    if (!catalogue.tilesById[id]) error(`${name} names a tile "${id}" the catalogue does not hold`);
  }
  for (const id of statusIdsOf(topic)) {
    if (!catalogue.statusIds.has(id)) error(`${name} names a status "${id}" nobody authored`);
  }
}

function tileIdsOf(topic: DialogTopic): string[] {
  const ids: string[] = [];
  for (const leaf of topic.if ? conditionLeaves(topic.if) : []) {
    if (leaf.cond === "carries" || leaf.cond === "room_for") ids.push(leaf.tileId);
  }
  for (const effect of topic.do ?? []) {
    if (effect.effect !== "trade") continue;
    for (const side of [...effect.take, ...effect.give]) ids.push(side.tileId);
  }
  return ids;
}

function statusIdsOf(topic: DialogTopic): string[] {
  const ids: string[] = [];
  for (const leaf of topic.if ? conditionLeaves(topic.if) : []) {
    if (leaf.cond === "has_status") ids.push(leaf.statusId);
  }
  for (const effect of topic.do ?? []) {
    if (effect.effect === "add_status") ids.push(effect.statusId);
  }
  return ids;
}

function checkLine(
  line: DialogLine,
  what: string,
  error: (message: string) => void,
) {
  if (line.hear.length === 0 || line.hear.every((word) => word.trim() === "")) {
    error(`The ${what} listens for no word`);
  }
  if (line.say.trim() === "") error(`The ${what} says nothing`);
}

/**
 * Walk a level of topics, then each one's `then`.
 *
 * A duplicate is reported at the level it is on: "yes" twice under one reply is
 * a second row that can never fire, where "yes" under two different replies is
 * two perfectly good answers to two different questions.
 */
function checkTopics(
  topics: readonly DialogTopic[],
  where: string,
  depth: number,
  error: (message: string) => void,
  warn: (message: string) => void,
  catalogue?: DialogCatalogue,
) {
  const seen = new Set<string>();
  topics.forEach((topic, index) => {
    const name = `${where} ${index + 1}`;
    checkLine(topic, name, error);
    checkTopicRules(topic, name, error, warn, catalogue);
    for (const word of topic.hear) {
      if (seen.has(word)) {
        warn(`"${word}" is answered by an earlier ${where}, so ${name} never hears it`);
      }
      seen.add(word);
    }
    if (!topic.then?.length) return;
    if (depth >= MAX_DIALOG_DEPTH) {
      warn(`${name} nests replies ${depth + 1} deep; ${MAX_DIALOG_DEPTH} is as far as a conversation can follow`);
    }
    checkTopics(topic.then, `${name} reply`, depth + 1, error, warn, catalogue);
  });
}
