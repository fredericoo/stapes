import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useMemo, useState } from "react";
import {
  anchorNames,
  commandAt,
  DEFAULT_DIALOG,
  listAt,
  MAX_DIALOG_AMOUNT,
  validateDialog,
  withListAt,
  type CommandPath,
  type DialogChoice,
  type DialogCommand,
  type DialogCommandKind,
  type DialogDef,
  type DialogTrade,
  type TradeSide,
} from "../lib/dialog";
import {
  DIALOG_COMMAND_KINDS,
  DIALOG_COMMANDS,
  type CatalogDefaults,
} from "../lib/dialogCatalog";
import { resolveContainer, resolveItem } from "../lib/item";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { Button, Input, Select, Textarea } from "../ui";
import { DialogTryOut } from "./DialogTryOut";
import { DragHandle } from "./DragHandle";
import { EditorIssues } from "./EditorIssues";

/**
 * Author a dialog without touching JSON: the script as a list of commands,
 * nested lists indented under the commands that hold them — and the real
 * panel beside it, to press through.
 *
 * ## The list is the script
 *
 * One row per command, in the order the interpreter will run them. A choice
 * shows its buttons with each one's commands under it; a trade shows what
 * happens when it goes through and when it is cancelled. A row is dragged by
 * its grip to reorder among its neighbours or into any other list on the
 * page; the one move refused is into a list the row itself holds, which
 * would be a block holding its own trunk. A command of any kind can be added
 * at the end of any list, which is what makes the thing composable.
 *
 * ## Edited by path
 *
 * Every edit names the command it is about by its `CommandPath` and rewrites
 * the script — `updateCommandAt`, `insertCommandAt`, `removeCommandAt`,
 * `moveCommand` — on the terms `../lib/conditions` edits an `if`. A row is a
 * copy React already rendered, and the path is the only way a nested one can
 * say which node it means. Those helpers are exported and tested; the
 * components are the thin part.
 */

type Props = {
  dialog: DialogDef | undefined;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statusDefs: Record<string, StatusDef>;
  onChange: (next: DialogDef | undefined) => void;
};

/** The root list's group, for rows whose parent is the script itself. */
const ROOT_ID = "root";

/** Prefix of the droppable that means "at the end of this list". */
const INTO_PREFIX = "into:";

/** A path as a sortable id and a group name. `[]` is the root list. */
export function pathId(path: CommandPath): string {
  return path.length === 0 ? ROOT_ID : path.join(".");
}

export function parsePathId(id: string): number[] {
  if (id === ROOT_ID) return [];
  return id.split(".").map((part) => Number(part));
}

/** Does `path` start with `prefix`? A list under a command starts with it. */
export function startsWith(path: CommandPath, prefix: CommandPath): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((index, i) => path[i] === index);
}

/** The dialog with the command at `path` rewritten. */
export function updateCommandAt(
  dialog: DialogDef,
  path: CommandPath,
  change: (command: DialogCommand) => DialogCommand,
): DialogDef {
  const listPath = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const list = listAt(dialog, listPath);
  if (!list?.[index]) return dialog;
  return withListAt(
    dialog,
    listPath,
    list.map((c, i) => (i === index ? change(c) : c)),
  );
}

/** The dialog with `command` put in the list at `listPath`, at `index`. */
export function insertCommandAt(
  dialog: DialogDef,
  listPath: CommandPath,
  index: number,
  command: DialogCommand,
): DialogDef {
  const list = listAt(dialog, listPath);
  if (!list) return dialog;
  const at = Math.max(0, Math.min(list.length, index));
  return withListAt(dialog, listPath, [
    ...list.slice(0, at),
    command,
    ...list.slice(at),
  ]);
}

/** The dialog without the command at `path`, blocks and all. */
export function removeCommandAt(
  dialog: DialogDef,
  path: CommandPath,
): DialogDef {
  const listPath = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const list = listAt(dialog, listPath);
  if (!list?.[index]) return dialog;
  return withListAt(
    dialog,
    listPath,
    list.filter((_, i) => i !== index),
  );
}

/**
 * The dialog with the command at `from` moved into the list at `toList`, at
 * `index` — or unchanged when the move is into a list the command holds.
 *
 * Removed first and inserted second, with the destination re-read after the
 * removal: taking a command out of a list shifts every index after it, and a
 * destination named against the old script would land one off.
 */
export function moveCommand(
  dialog: DialogDef,
  from: CommandPath,
  toList: CommandPath,
  index: number,
): DialogDef {
  const moving = commandAt(dialog, from);
  if (!moving || startsWith(toList, from)) return dialog;
  const without = removeCommandAt(dialog, from);
  return insertCommandAt(
    without,
    adjustedForRemoval(toList, from),
    index,
    moving,
  );
}

/**
 * A destination list re-read after `removed` is gone.
 *
 * Only a destination inside the removed command's own list and after it
 * moves, and it moves by one: everything else was untouched by the removal.
 */
function adjustedForRemoval(
  listPath: CommandPath,
  removed: CommandPath,
): number[] {
  const holder = removed.slice(0, -1);
  const removedIndex = removed[removed.length - 1]!;
  const out = [...listPath];
  const inSameList = holder.length < out.length && startsWith(out, holder);
  if (inSameList && out[holder.length]! > removedIndex)
    out[holder.length]! -= 1;
  return out;
}

type EditorContext = {
  dialog: DialogDef;
  itemOptions: Array<{ value: string; label: string }>;
  statusOptions: Array<{ value: string; label: string }>;
  defaults: CatalogDefaults;
  update: (
    path: CommandPath,
    change: (command: DialogCommand) => DialogCommand,
  ) => void;
  remove: (path: CommandPath) => void;
  append: (listPath: CommandPath, kind: DialogCommandKind) => void;
};

export function DialogEditor({
  dialog,
  tiles,
  tilesets,
  statusDefs,
  onChange,
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const itemOptions = useMemo(
    () =>
      tiles
        .filter(
          (tile) => resolveItem(tile) != null && resolveContainer(tile) == null,
        )
        .map((tile) => ({ value: tile.id, label: tile.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tiles],
  );
  const statusOptions = useMemo(
    () =>
      Object.values(statusDefs).map((def) => ({
        value: def.id,
        label: def.name,
      })),
    [statusDefs],
  );

  if (!dialog) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] leading-snug text-muted">
          This body has nothing to say. A dialog gives it a{" "}
          <strong>Talk</strong> row and a panel, and makes the tile an actor.
        </p>
        <Button onClick={() => onChange({ ...DEFAULT_DIALOG })}>
          Add dialog
        </Button>
      </div>
    );
  }

  const issues = validateDialog(dialog, {
    tilesById,
    statusIds: new Set(Object.keys(statusDefs)),
  });
  const ctx: EditorContext = {
    dialog,
    itemOptions,
    statusOptions,
    defaults: {
      tileId: itemOptions[0]?.value ?? "",
      statusId: statusOptions[0]?.value ?? "",
    },
    update: (path, change) => onChange(updateCommandAt(dialog, path, change)),
    remove: (path) => onChange(removeCommandAt(dialog, path)),
    append: (listPath, kind) =>
      onChange(
        insertCommandAt(
          dialog,
          listPath,
          Number.MAX_SAFE_INTEGER,
          DIALOG_COMMANDS[kind].make(ctx.defaults),
        ),
      ),
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase text-muted">Script</h3>
          <Button
            size="sm"
            variant="danger"
            onClick={() => onChange(undefined)}
          >
            Remove dialog
          </Button>
        </div>
        <EditorIssues issues={issues} />
        <DragDropProvider
          onDragEnd={(event) => {
            const next = dropped(dialog, event);
            if (next !== dialog) onChange(next);
          }}
        >
          <CommandList listPath={[]} commands={dialog.script} ctx={ctx} />
        </DragDropProvider>
      </div>

      <DialogTryOut
        dialog={dialog}
        tiles={tiles}
        tilesets={tilesets}
        statusDefs={statusDefs}
        className="lg:sticky lg:top-0 lg:self-start"
      />
    </div>
  );
}

type DragEndEvent = Parameters<
  NonNullable<React.ComponentProps<typeof DragDropProvider>["onDragEnd"]>
>[0];

/**
 * Where a drag left a command, read off the sortable it moved.
 *
 * The sortable plugin has already re-grouped and re-indexed the row while it
 * was dragged, so the source's `group` and `index` are where it now sits and
 * `initialGroup` / `initialIndex` are where it came from. A drop on a list's
 * end target — the one thing an empty list has to offer — is the one case the
 * plugin does not know, so it is read off the target instead: into that
 * list, last.
 */
function dropped(dialog: DialogDef, event: DragEndEvent): DialogDef {
  if (event.canceled) return dialog;
  const { source, target } = event.operation;
  if (!isSortable(source)) return dialog;
  const from = [
    ...parsePathId(String(source.initialGroup ?? ROOT_ID)),
    source.initialIndex,
  ];

  const targetId = target && !isSortable(target) ? String(target.id) : null;
  if (targetId?.startsWith(INTO_PREFIX)) {
    const into = parsePathId(targetId.slice(INTO_PREFIX.length));
    return moveCommand(dialog, from, into, Number.MAX_SAFE_INTEGER);
  }

  const toList = parsePathId(String(source.group ?? ROOT_ID));
  if (
    pathId(toList) === pathId(from.slice(0, -1)) &&
    source.index === source.initialIndex
  ) {
    return dialog;
  }
  return moveCommand(dialog, from, toList, source.index);
}

function CommandList({
  listPath,
  commands,
  ctx,
}: {
  listPath: CommandPath;
  commands: readonly DialogCommand[];
  ctx: EditorContext;
}) {
  return (
    <div className="flex flex-col gap-1">
      {commands.map((command, index) => (
        <CommandRow
          key={pathId([...listPath, index])}
          path={[...listPath, index]}
          command={command}
          ctx={ctx}
        />
      ))}
      <ListEnd listPath={listPath} ctx={ctx} />
    </div>
  );
}

/**
 * The row under a list: a place to drop a command into it, and the control
 * that adds one of any kind. A list with rows can be dropped between them;
 * this is what an empty list has to offer, and what "put it last" means for a
 * full one.
 */
function ListEnd({
  listPath,
  ctx,
}: {
  listPath: CommandPath;
  ctx: EditorContext;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `${INTO_PREFIX}${pathId(listPath)}`,
  });
  const [kind, setKind] = useState<DialogCommandKind>("say");
  return (
    <div
      ref={ref}
      className={[
        "flex flex-wrap items-center gap-2 border-2 border-dashed px-2 py-1",
        isDropTarget ? "border-accent bg-accent/10" : "border-border/40",
      ].join(" ")}
    >
      <Select
        value={kind}
        onValueChange={(v) => v && setKind(v as DialogCommandKind)}
        options={DIALOG_COMMAND_KINDS.map((k) => ({
          value: k,
          label: DIALOG_COMMANDS[k].label,
        }))}
        className="min-w-[8rem]"
        ariaLabel="Command to add"
      />
      <Button
        size="sm"
        variant="secondary"
        className="shrink-0 whitespace-nowrap"
        onClick={() => ctx.append(listPath, kind)}
      >
        + add
      </Button>
      <span className="text-[11px] leading-snug text-muted">
        {DIALOG_COMMANDS[kind].hint}
      </span>
    </div>
  );
}

function CommandRow({
  path,
  command,
  ctx,
}: {
  path: CommandPath;
  command: DialogCommand;
  ctx: EditorContext;
}) {
  const index = path[path.length - 1]!;
  const { ref, handleRef, isDragging } = useSortable({
    id: pathId(path),
    index,
    group: pathId(path.slice(0, -1)),
  });
  const set = (next: DialogCommand) => ctx.update(path, () => next);

  return (
    <div
      ref={ref}
      className={[
        "flex flex-col gap-1 border-2 border-border bg-panel p-1.5",
        isDragging ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-1">
        <DragHandle
          handleRef={handleRef}
          label={`Move ${DIALOG_COMMANDS[command.kind].label}`}
        />
        <span className="border border-border bg-paper px-1 font-mono text-[11px] uppercase">
          {DIALOG_COMMANDS[command.kind].label}
        </span>
        <CommandFields command={command} ctx={ctx} onChange={set} />
        <Button
          size="sm"
          variant="danger"
          className="ml-auto"
          onClick={() => ctx.remove(path)}
          aria-label={`Remove ${DIALOG_COMMANDS[command.kind].label}`}
        >
          ✕
        </Button>
      </div>
      <CommandBlocks path={path} command={command} ctx={ctx} onChange={set} />
    </div>
  );
}

/** The one-line part of a command: what it says, names, or points at. */
function CommandFields({
  command,
  ctx,
  onChange,
}: {
  command: DialogCommand;
  ctx: EditorContext;
  onChange: (next: DialogCommand) => void;
}) {
  if (command.kind === "say") {
    return (
      <Textarea
        rows={1}
        value={command.text}
        onChange={(e) => onChange({ ...command, text: e.target.value })}
        className="min-w-0 flex-1"
        aria-label="Line"
      />
    );
  }
  if (command.kind === "anchor") {
    return (
      <Input
        value={command.name}
        onChange={(e) => onChange({ ...command, name: e.target.value })}
        className="w-32 font-mono"
        placeholder="name"
        aria-label="Anchor name"
      />
    );
  }
  if (command.kind === "goto")
    return <GotoField command={command} ctx={ctx} onChange={onChange} />;
  if (command.kind === "tag") {
    return (
      <Input
        value={command.tag}
        onChange={(e) => onChange({ ...command, tag: e.target.value })}
        className="w-32 font-mono"
        placeholder="tag"
        aria-label="Tag"
      />
    );
  }
  if (command.kind === "add_status" || command.kind === "remove_status") {
    return (
      <Select
        value={command.statusId || null}
        onValueChange={(v) => v && onChange({ ...command, statusId: v })}
        options={ctx.statusOptions}
        placeholder="Status…"
        className="min-w-[8rem]"
        ariaLabel="Status"
      />
    );
  }
  return null;
}

/**
 * Where a goto lands, offered as the anchors that exist — and, for one that
 * names none of them, as the name it has, so a script mid-edit keeps reading
 * what the author typed rather than snapping to the first anchor.
 */
function GotoField({
  command,
  ctx,
  onChange,
}: {
  command: Extract<DialogCommand, { kind: "goto" }>;
  ctx: EditorContext;
  onChange: (next: DialogCommand) => void;
}) {
  const anchors = anchorNames(ctx.dialog);
  const options = anchors.includes(command.name)
    ? anchors
    : [command.name, ...anchors];
  return (
    <Select
      value={command.name}
      onValueChange={(v) => v && onChange({ ...command, name: v })}
      options={options.map((name) => ({ value: name, label: name }))}
      className="min-w-[8rem]"
      ariaLabel="Anchor to jump to"
    />
  );
}

/** The nested parts of a command: a choice's buttons, a trade's two outcomes. */
function CommandBlocks({
  path,
  command,
  ctx,
  onChange,
}: {
  path: CommandPath;
  command: DialogCommand;
  ctx: EditorContext;
  onChange: (next: DialogCommand) => void;
}) {
  if (command.kind === "choices") {
    return (
      <ChoicesBlocks
        path={path}
        command={command}
        ctx={ctx}
        onChange={onChange}
      />
    );
  }
  if (command.kind === "request_trade") {
    return (
      <TradeBlocks path={path} trade={command} ctx={ctx} onChange={onChange} />
    );
  }
  return null;
}

function ChoicesBlocks({
  path,
  command,
  ctx,
  onChange,
}: {
  path: CommandPath;
  command: Extract<DialogCommand, { kind: "choices" }>;
  ctx: EditorContext;
  onChange: (next: DialogCommand) => void;
}) {
  const setOptions = (options: DialogChoice[]) =>
    onChange({ ...command, options });
  return (
    <div className="flex flex-col gap-2 pl-6">
      {command.options.map((option, i) => (
        <div
          key={i}
          className="flex flex-col gap-1 border-l-2 border-border/40 pl-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-muted">
              Button
            </span>
            <Input
              value={option.label}
              onChange={(e) =>
                setOptions(
                  command.options.map((o, j) =>
                    j === i ? { ...o, label: e.target.value } : o,
                  ),
                )
              }
              className="w-40 font-bold"
              aria-label="Button label"
            />
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                setOptions(command.options.filter((_, j) => j !== i))
              }
              aria-label={`Remove button "${option.label}"`}
            >
              ✕
            </Button>
          </div>
          <CommandList
            listPath={[...path, i]}
            commands={option.then}
            ctx={ctx}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        className="self-start whitespace-nowrap"
        onClick={() =>
          setOptions([...command.options, { label: "New button", then: [] }])
        }
      >
        + button
      </Button>
    </div>
  );
}

function TradeBlocks({
  path,
  trade,
  ctx,
  onChange,
}: {
  path: CommandPath;
  trade: DialogTrade;
  ctx: EditorContext;
  onChange: (next: DialogCommand) => void;
}) {
  const number =
    (key: "min" | "max" | "default") =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Math.max(
        1,
        Math.min(MAX_DIALOG_AMOUNT, Number(e.target.value) || 1),
      );
      onChange({ ...trade, [key]: value });
    };
  return (
    <div className="flex flex-col gap-2 pl-6">
      <TradeSides
        label="Takes"
        sides={trade.take}
        ctx={ctx}
        onChange={(take) => onChange({ ...trade, take })}
      />
      <TradeSides
        label="Gives"
        sides={trade.give}
        ctx={ctx}
        onChange={(give) => onChange({ ...trade, give })}
      />
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase text-muted">
        <span>how many: from</span>
        <Input
          type="number"
          min={1}
          max={MAX_DIALOG_AMOUNT}
          value={trade.min}
          onChange={number("min")}
          className="w-16"
          aria-label="Least"
        />
        <span>to</span>
        <Input
          type="number"
          min={1}
          max={MAX_DIALOG_AMOUNT}
          value={trade.max}
          onChange={number("max")}
          className="w-16"
          aria-label="Most"
        />
        <span>starting at</span>
        <Input
          type="number"
          min={1}
          max={MAX_DIALOG_AMOUNT}
          value={trade.default ?? trade.min}
          onChange={number("default")}
          className="w-16"
          aria-label="Starting quantity"
        />
      </div>
      <div className="flex flex-col gap-1 border-l-2 border-border/40 pl-2">
        <span className="text-[10px] font-bold uppercase text-muted">
          When traded
        </span>
        <CommandList
          listPath={[...path, 0]}
          commands={trade.traded}
          ctx={ctx}
        />
      </div>
      <div className="flex flex-col gap-1 border-l-2 border-border/40 pl-2">
        <span className="text-[10px] font-bold uppercase text-muted">
          When cancelled
        </span>
        <CommandList
          listPath={[...path, 1]}
          commands={trade.cancel}
          ctx={ctx}
        />
      </div>
    </div>
  );
}

function TradeSides({
  label,
  sides,
  ctx,
  onChange,
}: {
  label: string;
  sides: readonly TradeSide[];
  ctx: EditorContext;
  onChange: (next: TradeSide[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-10 text-[10px] font-bold uppercase text-muted">
        {label}
      </span>
      {sides.map((side, i) => (
        <span key={i} className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={MAX_DIALOG_AMOUNT}
            value={side.count}
            onChange={(e) =>
              onChange(
                sides.map((s, j) =>
                  j === i
                    ? { ...s, count: Math.max(1, Number(e.target.value) || 1) }
                    : s,
                ),
              )
            }
            className="w-16"
            aria-label="Count"
          />
          <Select
            value={side.tileId || null}
            onValueChange={(v) =>
              v &&
              onChange(sides.map((s, j) => (j === i ? { ...s, tileId: v } : s)))
            }
            options={ctx.itemOptions}
            placeholder="Tile…"
            className="min-w-[9rem]"
            ariaLabel="Tile"
          />
          <Button
            size="sm"
            variant="danger"
            onClick={() => onChange(sides.filter((_, j) => j !== i))}
            aria-label={`Remove ${label.toLowerCase()} entry`}
          >
            ✕
          </Button>
        </span>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          onChange([...sides, { tileId: ctx.defaults.tileId, count: 1 }])
        }
      >
        +
      </Button>
    </div>
  );
}
