import * as v from "valibot";
import { resolveContainer } from "./item";
import type { TileDef } from "./types";

/**
 * A conversation an NPC can hold, authored as a script of commands.
 *
 * ## An event, not a menu
 *
 * A dialog is an ordered list of commands, the way an RPG Maker event is: say
 * a line, offer choices, ask for a trade, mark the player, jump to a label.
 * Some commands hold nested lists — each choice has the commands it leads to,
 * a trade has what happens when it goes through and when it is cancelled —
 * and the interpreter (`../game/dialogRuntime`) runs one list at a time,
 * descending into a branch on the player's press and continuing after the
 * block when the branch runs out. `anchor` and `goto` are how a script comes
 * back to its menu; running off the end is how it stops.
 *
 * This replaced a tree of buttons, where every button carried its own
 * condition, reply and effects. That shape could say one thing per press and
 * nothing between presses; a script says as much as it likes, in any order,
 * and a new kind of command is one more arm rather than a new field on every
 * option. `if` is the arm coming next, and the interpreter already treats
 * every nested list the same, so it will be a block like any other.
 *
 * ## What the player sees
 *
 * A transcript. Every line said and every choice made stays on the panel,
 * and the only controls are the ones the command the script is waiting on
 * needs: buttons for `choices`, a preview with a quantity and Trade / Cancel
 * for `request_trade`. When the script ends, the transcript stays and the
 * close button is all that is left.
 *
 * Parsed with valibot and memoised on def identity, on the same trust model
 * as every other interaction block: a malformed dialog is a body with no Talk
 * row, never a crashed world.
 */

/** So many of one tile, as one side of a trade. */
export type TradeSide = { tileId: string; count: number };

export type DialogTrade = {
  kind: "request_trade";
  take: TradeSide[];
  give: TradeSide[];
  min: number;
  max: number;
  default?: number;
  traded: DialogCommand[];
  cancel: DialogCommand[];
};

export type DialogChoice = { label: string; then: DialogCommand[] };

export type DialogCommand =
  /** A line from the NPC. `{partner}` is the player's name. */
  | { kind: "say"; text: string }
  /** A place a `goto` can land. Names are unique across the whole script. */
  | { kind: "anchor"; name: string }
  /**
   * Continue from just after the anchor of that name, wherever it is — a
   * branch jumping to its menu unwinds out of the branch to do so.
   */
  | { kind: "goto"; name: string }
  /** Buttons, and the commands each leads to. Waits for a press. */
  | { kind: "choices"; options: DialogChoice[] }
  /**
   * Offer a trade and wait for Trade or Cancel.
   *
   * `take` and `give` are per unit; the player picks how many units between
   * `min` and `max`, starting at `default`. On Trade the whole plan is run at
   * once — all or nothing, nothing on the floor — and `traded` continues;
   * on Cancel, `cancel` does. See `../game/trade`.
   */
  | DialogTrade
  /** Put a status on the player, for the status's own duration. */
  | { kind: "add_status"; statusId: string }
  /** Take a status off the player, if they are under it. */
  | { kind: "remove_status"; statusId: string }
  /** Mark the player, on a reward tag's terms. */
  | { kind: "tag"; tag: string };

export type DialogCommandKind = DialogCommand["kind"];

export type DialogDef = { script: DialogCommand[] };

/**
 * The most of anything one trade may move, and the widest a quantity may be.
 *
 * A sanity bound on the terms `MAX_PILE` is: two digits is more bottles than
 * anybody is carrying, and a typo'd third reads as malformed rather than as a
 * shop that buys a thousand.
 */
export const MAX_DIALOG_AMOUNT = 99;

/**
 * How deep blocks may nest before the editor says something.
 *
 * A warning rather than a refusal: nothing breaks at four, but a choice four
 * blocks deep is one the outline will not fit on a screen.
 */
export const MAX_DIALOG_DEPTH = 3;

/** What a fresh dialog says, so the editor has something to show. */
export const DEFAULT_DIALOG: DialogDef = {
  script: [{ kind: "say", text: "Hello, {partner}." }],
};

const tileId = v.pipe(v.string(), v.trim(), v.minLength(1));
const name = v.pipe(v.string(), v.trim(), v.minLength(1));
const line = v.pipe(v.string(), v.minLength(1));
const count = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DIALOG_AMOUNT));

const tradeSideSchema = v.object({ tileId, count });

// Recursive through every block, the way `./conditions` is through `rules`:
// a command holds commands, and valibot needs to be told the type it will
// arrive at.
const commandSchema: v.GenericSchema<unknown, DialogCommand> = v.variant("kind", [
  v.object({ kind: v.literal("say"), text: line }),
  v.object({ kind: v.literal("anchor"), name }),
  v.object({ kind: v.literal("goto"), name }),
  v.object({
    kind: v.literal("choices"),
    options: v.pipe(
      v.array(
        v.object({
          label: v.pipe(v.string(), v.trim(), v.minLength(1)),
          then: v.array(v.lazy(() => commandSchema)),
        }),
      ),
      v.minLength(1),
    ),
  }),
  v.pipe(
    v.object({
      kind: v.literal("request_trade"),
      take: v.array(tradeSideSchema),
      give: v.array(tradeSideSchema),
      min: count,
      max: count,
      default: v.optional(count),
      traded: v.array(v.lazy(() => commandSchema)),
      cancel: v.array(v.lazy(() => commandSchema)),
    }),
    // A trade of nothing for nothing is a command that should not be one.
    v.check((raw) => raw.take.length + raw.give.length > 0, "a trade moves something"),
    v.check((raw) => raw.max >= raw.min, "a quantity's ceiling is at least its floor"),
  ),
  v.object({ kind: v.literal("add_status"), statusId: tileId }),
  v.object({ kind: v.literal("remove_status"), statusId: tileId }),
  v.object({ kind: v.literal("tag"), tag: name }),
]);

const dialogSchema = v.object({ script: v.array(commandSchema) });

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
 * Where a command sits: indices into nested lists, alternating a command's
 * position in its list with which of its branches to descend — `[2, 0, 1]` is
 * the second command inside the first branch of the third command. `[]` is
 * the root list itself; a path of odd length names a command, of even length
 * a list.
 *
 * One shape for the interpreter's counter, the editor's cursor and a drag's
 * destination, so none of them can disagree about what a position means.
 */
export type CommandPath = readonly number[];

/** The nested lists a command holds, in branch order. */
export function branchesOf(command: DialogCommand): readonly DialogCommand[][] {
  if (command.kind === "choices") return command.options.map((option) => option.then);
  if (command.kind === "request_trade") return [command.traded, command.cancel];
  return [];
}

/** The command with branch `index` replaced. */
export function withBranch(
  command: DialogCommand,
  index: number,
  list: DialogCommand[],
): DialogCommand {
  if (command.kind === "choices") {
    return {
      ...command,
      options: command.options.map((option, i) => (i === index ? { ...option, then: list } : option)),
    };
  }
  if (command.kind === "request_trade") {
    return index === 0 ? { ...command, traded: list } : { ...command, cancel: list };
  }
  return command;
}

/** The list at an even-length path, or null when the path names nothing. */
export function listAt(dialog: DialogDef, path: CommandPath): DialogCommand[] | null {
  let list: DialogCommand[] | null = dialog.script;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const command: DialogCommand | undefined = list?.[path[i]!];
    const branch: DialogCommand[] | undefined = command && branchesOf(command)[path[i + 1]!];
    if (!branch) return null;
    list = branch;
  }
  return list;
}

/** The command at an odd-length path, or null when the path names nothing. */
export function commandAt(dialog: DialogDef, path: CommandPath): DialogCommand | null {
  if (path.length % 2 === 0) return null;
  return listAt(dialog, path.slice(0, -1))?.[path[path.length - 1]!] ?? null;
}

/** The dialog with the list at an even-length path replaced. */
export function withListAt(
  dialog: DialogDef,
  path: CommandPath,
  list: DialogCommand[],
): DialogDef {
  if (path.length === 0) return { script: list };
  const parentPath = path.slice(0, -2);
  const parent = listAt(dialog, parentPath);
  const index = path[path.length - 2]!;
  const branch = path[path.length - 1]!;
  const command = parent?.[index];
  if (!parent || !command) return dialog;
  const next = parent.map((c, i) => (i === index ? withBranch(command, branch, list) : c));
  return withListAt(dialog, parentPath, next);
}

/** Every command in the script, root first, each with its path. */
export function walkCommands(
  dialog: DialogDef,
): Array<{ path: number[]; command: DialogCommand }> {
  const out: Array<{ path: number[]; command: DialogCommand }> = [];
  const visit = (list: readonly DialogCommand[], at: number[]) => {
    list.forEach((command, index) => {
      const path = [...at, index];
      out.push({ path, command });
      branchesOf(command).forEach((branch, b) => visit(branch, [...path, b]));
    });
  };
  visit(dialog.script, []);
  return out;
}

/** Where the anchor of this name is, or null. The first one wins. */
export function anchorPath(dialog: DialogDef, anchor: string): number[] | null {
  for (const { path, command } of walkCommands(dialog)) {
    if (command.kind === "anchor" && command.name === anchor) return path;
  }
  return null;
}

/** Every anchor name in the script, in order of appearance, once each. */
export function anchorNames(dialog: DialogDef): string[] {
  const names: string[] = [];
  for (const { command } of walkCommands(dialog)) {
    if (command.kind === "anchor" && !names.includes(command.name)) names.push(command.name);
  }
  return names;
}

/** The quantity a trade opens at, or one requested, held to its range. */
export function clampAmount(trade: DialogTrade, requested: number | undefined): number {
  const wanted = Math.round(requested ?? trade.default ?? trade.min);
  return Math.min(trade.max, Math.max(trade.min, wanted));
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
 * The same contract `validateBrain` keeps: errors are what would make the
 * block fail to parse or a jump land nowhere — said here in words, because
 * the editor holds a draft and a schema failure names a path rather than a
 * problem — and warnings are things that parse and are almost certainly not
 * what the author meant.
 */
export function validateDialog(
  dialog: DialogDef,
  catalogue?: DialogCatalogue,
): DialogIssue[] {
  const issues: DialogIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const warn = (message: string) => issues.push({ severity: "warn", message });

  if (dialog.script.length === 0) warn("The script is empty: Talk opens a panel with nothing in it");

  const anchors = new Map<string, number>();
  const all = walkCommands(dialog);
  for (const { command } of all) {
    if (command.kind === "anchor") anchors.set(command.name, (anchors.get(command.name) ?? 0) + 1);
  }
  for (const [anchor, times] of anchors) {
    if (times > 1) warn(`Anchor "${anchor}" appears ${times} times; a goto lands on the first`);
  }

  for (const { path, command } of all) {
    const where = `${command.kind} at ${path.join(".")}`;
    const depth = Math.floor(path.length / 2);
    if (depth > MAX_DIALOG_DEPTH && path[path.length - 1] === 0) {
      warn(`${where} is ${depth} blocks deep; ${MAX_DIALOG_DEPTH} is as far as an outline can follow`);
    }
    checkCommand(command, where, anchors, error, catalogue);
  }
  return issues;
}

function checkCommand(
  command: DialogCommand,
  where: string,
  anchors: ReadonlyMap<string, number>,
  error: (message: string) => void,
  catalogue?: DialogCatalogue,
) {
  if (command.kind === "say" && command.text.trim() === "") error(`${where} says nothing`);
  if (command.kind === "anchor" && command.name.trim() === "") error(`${where} has no name`);
  if (command.kind === "goto" && !anchors.has(command.name)) {
    error(`${where} jumps to "${command.name}", and no anchor has that name`);
  }
  if (command.kind === "tag" && command.tag.trim() === "") error(`${where} has no tag`);
  if (command.kind === "choices") checkChoices(command.options, where, error);
  if (command.kind === "request_trade") checkTrade(command, where, error, catalogue);
  if (!catalogue) return;
  if (command.kind === "add_status" || command.kind === "remove_status") {
    if (!catalogue.statusIds.has(command.statusId)) {
      error(`${where} names a status "${command.statusId}" nobody authored`);
    }
  }
}

function checkChoices(
  options: readonly DialogChoice[],
  where: string,
  error: (message: string) => void,
) {
  if (options.length === 0) error(`${where} offers nothing to press`);
  const seen = new Set<string>();
  for (const option of options) {
    const label = option.label.trim().toLowerCase();
    if (label === "") error(`${where} has a button with no label`);
    if (seen.has(label)) error(`${where} has two buttons reading "${option.label}"`);
    seen.add(label);
  }
}

function checkTrade(
  trade: DialogTrade,
  where: string,
  error: (message: string) => void,
  catalogue?: DialogCatalogue,
) {
  if (trade.take.length + trade.give.length === 0) error(`${where} trades nothing for nothing`);
  if (trade.max < trade.min) error(`${where} has a quantity whose ceiling is below its floor`);
  if (trade.default !== undefined && (trade.default < trade.min || trade.default > trade.max)) {
    error(`${where} opens at a quantity outside its own range`);
  }
  if (!catalogue) return;
  for (const side of [...trade.take, ...trade.give]) {
    const def = catalogue.tilesById[side.tileId];
    if (!def) error(`${where} names a tile "${side.tileId}" the catalogue does not hold`);
    else if (resolveContainer(def)) {
      error(`${where} trades ${def.name}, and a container is not a thing a trade may move`);
    }
  }
}
