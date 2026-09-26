import * as v from "valibot";
import { resolveContainer } from "./item";
import type { TileDef } from "./types";

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
  | { kind: "say"; text: string }
  | { kind: "anchor"; name: string }
  | { kind: "goto"; name: string }
  | { kind: "choices"; options: DialogChoice[] }
  | DialogTrade
  | { kind: "add_status"; statusId: string }
  | { kind: "remove_status"; statusId: string }
  | { kind: "tag"; tag: string };

export type DialogCommandKind = DialogCommand["kind"];

export type DialogDef = { script: DialogCommand[] };

export const MAX_DIALOG_AMOUNT = 99;

export const MAX_DIALOG_DEPTH = 3;

export const DEFAULT_DIALOG: DialogDef = {
  script: [{ kind: "say", text: "Hello, {partner}." }],
};

const tileId = v.pipe(v.string(), v.trim(), v.minLength(1));
const name = v.pipe(v.string(), v.trim(), v.minLength(1));
const line = v.pipe(v.string(), v.minLength(1));
const count = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DIALOG_AMOUNT));

const tradeSideSchema = v.object({ tileId, count });

/**
 * Typed explicitly and referenced through `v.lazy` inside its own options and
 * trade branches, since TypeScript cannot otherwise infer the type of a
 * schema that points back at itself.
 */
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
    v.check((raw) => raw.take.length + raw.give.length > 0, "a trade moves something"),
    v.check((raw) => raw.max >= raw.min, "a quantity's ceiling is at least its floor"),
  ),
  v.object({ kind: v.literal("add_status"), statusId: tileId }),
  v.object({ kind: v.literal("remove_status"), statusId: tileId }),
  v.object({ kind: v.literal("tag"), tag: name }),
]);

const dialogSchema = v.object({ script: v.array(commandSchema) });

const dialogCache = new WeakMap<TileDef, DialogDef | null>();

export function resolveDialog(def: TileDef): DialogDef | null {
  const cached = dialogCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.dialog;
  const parsed = raw == null ? null : v.safeParse(dialogSchema, raw);
  const dialog = parsed?.success ? parsed.output : null;
  dialogCache.set(def, dialog);
  return dialog;
}

export type CommandPath = readonly number[];

export function branchesOf(command: DialogCommand): readonly DialogCommand[][] {
  if (command.kind === "choices") return command.options.map((option) => option.then);
  if (command.kind === "request_trade") return [command.traded, command.cancel];
  return [];
}

export function withBranch(
  command: DialogCommand,
  index: number,
  list: DialogCommand[],
): DialogCommand {
  if (command.kind === "choices") {
    return {
      ...command,
      options: command.options.map((option, i) =>
        i === index ? { ...option, then: list } : option,
      ),
    };
  }
  if (command.kind === "request_trade") {
    return index === 0 ? { ...command, traded: list } : { ...command, cancel: list };
  }
  return command;
}

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

export function commandAt(dialog: DialogDef, path: CommandPath): DialogCommand | null {
  if (path.length % 2 === 0) return null;
  return listAt(dialog, path.slice(0, -1))?.[path[path.length - 1]!] ?? null;
}

export function withListAt(dialog: DialogDef, path: CommandPath, list: DialogCommand[]): DialogDef {
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

export function walkCommands(dialog: DialogDef): Array<{ path: number[]; command: DialogCommand }> {
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

export function anchorPath(dialog: DialogDef, anchor: string): number[] | null {
  for (const { path, command } of walkCommands(dialog)) {
    if (command.kind === "anchor" && command.name === anchor) return path;
  }
  return null;
}

export function anchorNames(dialog: DialogDef): string[] {
  const names: string[] = [];
  for (const { command } of walkCommands(dialog)) {
    if (command.kind === "anchor" && !names.includes(command.name)) names.push(command.name);
  }
  return names;
}

export function clampAmount(trade: DialogTrade, requested: number | undefined): number {
  const wanted = Math.round(requested ?? trade.default ?? trade.min);
  return Math.min(trade.max, Math.max(trade.min, wanted));
}

export type DialogIssue = { severity: "error" | "warn"; message: string };

export type DialogCatalogue = {
  tilesById: Record<string, TileDef>;
  statusIds: ReadonlySet<string>;
};

export function validateDialog(dialog: DialogDef, catalogue?: DialogCatalogue): DialogIssue[] {
  const issues: DialogIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const warn = (message: string) => issues.push({ severity: "warn", message });

  if (dialog.script.length === 0)
    warn("The script is empty: Talk opens a panel with nothing in it");

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
      warn(
        `${where} is ${depth} blocks deep; ${MAX_DIALOG_DEPTH} is as far as an outline can follow`,
      );
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
