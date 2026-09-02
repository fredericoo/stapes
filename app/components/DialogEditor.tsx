import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useMemo, useState } from "react";
import {
  DEFAULT_CONFIRM_LABEL,
  DEFAULT_DIALOG,
  MAX_DIALOG_AMOUNT,
  optionAt,
  validateDialog,
  type DialogAmount,
  type DialogConditionDef,
  type DialogDef,
  type DialogEffectDef,
  type DialogOption,
  type TradeSide,
} from "../lib/dialog";
import {
  DIALOG_CONDITION_NAMES,
  DIALOG_CONDITIONS,
  DIALOG_EFFECT_NAMES,
  DIALOG_EFFECTS,
  type CatalogDefaults,
} from "../lib/dialogCatalog";
import { resolveItem } from "../lib/item";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { Button, Input, Select, Switch, Textarea } from "../ui";
import { ConditionTreeEditor } from "./ConditionTreeEditor";
import { DialogTryOut } from "./DialogTryOut";
import { DragHandle } from "./DragHandle";
import { EditorIssues } from "./EditorIssues";

/**
 * Author a dialog without touching JSON: an outline of options, nested as
 * deep as the tree goes, each with its condition, its effects and its
 * follow-ups — and the real panel beside it, to press through.
 *
 * ## The outline is the tree
 *
 * One card per option, its follow-ups indented under it, on the same page the
 * player will read it from — the panel shows a reply's follow-ups and nothing
 * else, so the outline shows the same nesting. A card is dragged by its grip
 * to reorder among its siblings, or into another option's follow-ups; the one
 * move refused is into its own descendants, which would be a branch holding
 * its trunk.
 *
 * ## Edited by path
 *
 * Every edit names the option it is about by its indices from the root and
 * rewrites the tree — `updateAt`, `insertAt`, `removeAt`, `moveOption` — on the
 * terms `../lib/conditions` edits an `if`. A card is a copy React already
 * rendered, and the path is the only way a nested one can say which node it
 * means. Those helpers are exported and tested; the components are the thin
 * part.
 */

type Props = {
  dialog: DialogDef | undefined;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statusDefs: Record<string, StatusDef>;
  onChange: (next: DialogDef | undefined) => void;
};

/** Indices from the root, one per `then` descended. */
export type OptionPath = readonly number[];

/** The root's group, for sortables whose parent is the dialog itself. */
const ROOT_ID = "root";

/** Prefix of the droppable that means "into this option's follow-ups". */
const INTO_PREFIX = "into:";

/** A path as a sortable id and a group name. `[]` is the root. */
export function pathId(path: OptionPath): string {
  return path.length === 0 ? ROOT_ID : path.join(".");
}

export function parsePathId(id: string): number[] {
  if (id === ROOT_ID) return [];
  return id.split(".").map((part) => Number(part));
}

/** Is `ancestor` a strict prefix of `path`? */
export function isAncestor(ancestor: OptionPath, path: OptionPath): boolean {
  if (ancestor.length >= path.length) return false;
  return ancestor.every((index, i) => path[i] === index);
}

/** The list an option at `path` sits in — the root's, or its parent's `then`. */
function siblingsOf(dialog: DialogDef, parent: OptionPath): DialogOption[] {
  if (parent.length === 0) return dialog.options;
  return optionAt(dialog, parent)?.then ?? [];
}

/** The dialog with the list at `parent` replaced. */
function withSiblings(dialog: DialogDef, parent: OptionPath, next: DialogOption[]): DialogDef {
  if (parent.length === 0) return { ...dialog, options: next };
  return updateAt(dialog, parent, (option) =>
    next.length === 0 ? withoutThen(option) : { ...option, then: next },
  );
}

/** An option with an empty `then` is an option with no `then`, in the file. */
function withoutThen(option: DialogOption): DialogOption {
  const { then: _dropped, ...rest } = option;
  return rest;
}

/** The dialog with the option at `path` rewritten. */
export function updateAt(
  dialog: DialogDef,
  path: OptionPath,
  change: (option: DialogOption) => DialogOption,
): DialogDef {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const siblings = siblingsOf(dialog, parent);
  if (!siblings[index]) return dialog;
  const next = siblings.map((option, i) => (i === index ? change(option) : option));
  return withSiblings(dialog, parent, next);
}

/** The dialog with `option` put among the children of `parent` at `index`. */
export function insertAt(
  dialog: DialogDef,
  parent: OptionPath,
  index: number,
  option: DialogOption,
): DialogDef {
  const siblings = siblingsOf(dialog, parent);
  const at = Math.max(0, Math.min(siblings.length, index));
  return withSiblings(dialog, parent, [...siblings.slice(0, at), option, ...siblings.slice(at)]);
}

/** The dialog without the option at `path`, follow-ups and all. */
export function removeAt(dialog: DialogDef, path: OptionPath): DialogDef {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const siblings = siblingsOf(dialog, parent);
  if (!siblings[index]) return dialog;
  return withSiblings(dialog, parent, siblings.filter((_, i) => i !== index));
}

/**
 * The dialog with the option at `from` moved among the children of `to`, at
 * `index` — or unchanged when the move is into its own descendants.
 *
 * Removed first and inserted second, with the destination re-read after the
 * removal: taking an option out of a list shifts every index after it, and a
 * destination named against the old tree would land one off.
 */
export function moveOption(
  dialog: DialogDef,
  from: OptionPath,
  to: OptionPath,
  index: number,
): DialogDef {
  const moving = optionAt(dialog, from);
  if (!moving) return dialog;
  if (isAncestor(from, to) || pathId(from) === pathId(to)) return dialog;

  const without = removeAt(dialog, from);
  const destination = adjustedForRemoval(to, from);
  return insertAt(without, destination, index, moving);
}

/**
 * A destination path re-read after `removed` is gone.
 *
 * Only a destination that shares the removed option's parent and sits after
 * it moves, and it moves by one: everything else was untouched by the removal.
 */
function adjustedForRemoval(path: OptionPath, removed: OptionPath): number[] {
  const parent = removed.slice(0, -1);
  const removedIndex = removed[removed.length - 1]!;
  const out = [...path];
  const sharesParent =
    parent.length < out.length && parent.every((index, i) => out[i] === index);
  if (sharesParent && out[parent.length]! > removedIndex) out[parent.length]! -= 1;
  return out;
}

/** A fresh option, worth pressing as soon as it is on the page. */
export function freshOption(): DialogOption {
  return { label: "New option", say: "…" };
}

type EditorContext = {
  tiles: TileDef[];
  itemOptions: Array<{ value: string; label: string }>;
  statusOptions: Array<{ value: string; label: string }>;
  defaults: CatalogDefaults;
  update: (path: OptionPath, change: (option: DialogOption) => DialogOption) => void;
  remove: (path: OptionPath) => void;
  add: (parent: OptionPath) => void;
};

export function DialogEditor({ dialog, tiles, tilesets, statusDefs, onChange }: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const itemOptions = useMemo(
    () =>
      tiles
        .filter((tile) => resolveItem(tile) != null)
        .map((tile) => ({ value: tile.id, label: tile.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tiles],
  );
  const statusOptions = useMemo(
    () => Object.values(statusDefs).map((def) => ({ value: def.id, label: def.name })),
    [statusDefs],
  );

  if (!dialog) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] leading-snug text-muted">
          This body has nothing to say. A dialog gives it a <strong>Talk</strong> row and
          a panel of buttons, and makes the tile an actor.
        </p>
        <Button onClick={() => onChange({ ...DEFAULT_DIALOG, options: [freshOption()] })}>
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
    tiles,
    itemOptions,
    statusOptions,
    defaults: {
      tileId: itemOptions[0]?.value ?? "",
      statusId: statusOptions[0]?.value ?? "",
    },
    update: (path, change) => onChange(updateAt(dialog, path, change)),
    remove: (path) => onChange(removeAt(dialog, path)),
    add: (parent) =>
      onChange(insertAt(dialog, parent, Number.MAX_SAFE_INTEGER, freshOption())),
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase text-muted">Dialog</h3>
          <Button size="sm" variant="danger" onClick={() => onChange(undefined)}>
            Remove dialog
          </Button>
        </div>
        <EditorIssues issues={issues} />

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-bold uppercase text-muted">Opening line</span>
          <Textarea
            rows={2}
            value={dialog.opening}
            onChange={(e) => onChange({ ...dialog, opening: e.target.value })}
            aria-label="Opening line"
          />
          <span className="text-[11px] leading-snug text-muted">
            What they say when Talk is pressed. <code>{"{partner}"}</code> is the player's name.
          </span>
        </label>

        <DragDropProvider
          onDragEnd={(event) => {
            const next = dropped(dialog, event);
            if (next !== dialog) onChange(next);
          }}
        >
          <OptionList parent={[]} options={dialog.options} depth={0} ctx={ctx} />
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
 * Where a drag left an option, read off the sortable it moved.
 *
 * The sortable plugin has already re-grouped and re-indexed the row while it
 * was dragged, so the source's `group` and `index` are where it now sits and
 * `initialGroup` / `initialIndex` are where it came from. A drop on a
 * follow-ups target that had no rows to sort among is the one case the plugin
 * does not know, so it is read off the target instead: into that option, last.
 */
function dropped(dialog: DialogDef, event: DragEndEvent): DialogDef {
  if (event.canceled) return dialog;
  const { source, target } = event.operation;
  if (!isSortable(source)) return dialog;
  const from = [...parsePathId(String(source.initialGroup ?? ROOT_ID)), source.initialIndex];

  const targetId = target && !isSortable(target) ? String(target.id) : null;
  if (targetId?.startsWith(INTO_PREFIX)) {
    const into = parsePathId(targetId.slice(INTO_PREFIX.length));
    return moveOption(dialog, from, into, Number.MAX_SAFE_INTEGER);
  }

  const to = parsePathId(String(source.group ?? ROOT_ID));
  if (pathId(to) === pathId(from.slice(0, -1)) && source.index === source.initialIndex) {
    return dialog;
  }
  return moveOption(dialog, from, to, source.index);
}

function OptionList({
  parent,
  options,
  depth,
  ctx,
}: {
  parent: OptionPath;
  options: readonly DialogOption[];
  depth: number;
  ctx: EditorContext;
}) {
  return (
    <div className="flex flex-col gap-1">
      {options.map((option, index) => (
        <OptionCard
          key={pathId([...parent, index])}
          path={[...parent, index]}
          option={option}
          depth={depth}
          ctx={ctx}
        />
      ))}
      <IntoTarget parent={parent} onAdd={() => ctx.add(parent)} empty={options.length === 0} />
    </div>
  );
}

/**
 * The row under a list: a place to drop an option into it, and the button
 * that adds one. A list with rows can be dropped between them; this is what
 * an empty list has to offer, and what "put it last" means for a full one.
 */
function IntoTarget({
  parent,
  onAdd,
  empty,
}: {
  parent: OptionPath;
  onAdd: () => void;
  empty: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({ id: `${INTO_PREFIX}${pathId(parent)}` });
  return (
    <div
      ref={ref}
      className={[
        "flex items-center gap-2 border-2 border-dashed px-2 py-1",
        isDropTarget ? "border-accent bg-accent/10" : "border-border/40",
      ].join(" ")}
    >
      <Button size="sm" variant="secondary" className="shrink-0 whitespace-nowrap" onClick={onAdd}>
        + option
      </Button>
      {empty ? (
        <span className="text-[11px] text-muted">
          {parent.length === 0 ? "Nothing to press yet." : "No follow-ups: only Back."}
        </span>
      ) : null}
    </div>
  );
}

function OptionCard({
  path,
  option,
  depth,
  ctx,
}: {
  path: OptionPath;
  option: DialogOption;
  depth: number;
  ctx: EditorContext;
}) {
  const index = path[path.length - 1]!;
  const { ref, handleRef, isDragging } = useSortable({
    id: pathId(path),
    index,
    group: pathId(path.slice(0, -1)),
  });
  const [open, setOpen] = useState(depth === 0);
  const set = (fields: Partial<DialogOption>) =>
    ctx.update(path, (current) => ({ ...current, ...fields }));

  return (
    <div
      ref={ref}
      className={[
        "flex flex-col gap-1 border-2 border-border bg-panel p-1.5",
        isDragging ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-1">
        <DragHandle handleRef={handleRef} label={`Move "${option.label}"`} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(!open)}
          aria-label={open ? "Collapse option" : "Expand option"}
          aria-expanded={open}
        >
          {open ? "▾" : "▸"}
        </Button>
        <Input
          value={option.label}
          onChange={(e) => set({ label: e.target.value })}
          className="w-48 font-bold"
          aria-label="Button label"
          placeholder="Button label"
        />
        <OptionSummary option={option} />
        <Button
          size="sm"
          variant="danger"
          className="ml-auto"
          onClick={() => ctx.remove(path)}
          aria-label={`Remove "${option.label}"`}
        >
          ✕
        </Button>
      </div>

      {open ? <OptionBody path={path} option={option} depth={depth} ctx={ctx} set={set} /> : null}
    </div>
  );
}

/** What a collapsed card says about itself, in a few marks. */
function OptionSummary({ option }: { option: DialogOption }) {
  const marks: string[] = [];
  if (option.if) marks.push("if");
  if (option.do?.length) marks.push(`${option.do.length} effect${option.do.length === 1 ? "" : "s"}`);
  if (option.amount) marks.push("asks how many");
  if (option.then?.length) marks.push(`${option.then.length} follow-up${option.then.length === 1 ? "" : "s"}`);
  return (
    <span className="truncate text-[11px] text-muted">
      {marks.join(" · ")}
    </span>
  );
}

function OptionBody({
  path,
  option,
  depth,
  ctx,
  set,
}: {
  path: OptionPath;
  option: DialogOption;
  depth: number;
  ctx: EditorContext;
  set: (fields: Partial<DialogOption>) => void;
}) {
  const canRefuse = option.if != null || (option.do?.length ?? 0) > 0;
  return (
    <div className="flex flex-col gap-2 pl-6">
      <Field label="Says" hint="The reply when this is pressed and allowed.">
        <Textarea
          rows={2}
          value={option.say}
          onChange={(e) => set({ say: e.target.value })}
          aria-label="Reply"
        />
      </Field>

      <ToggledSection
        label="Only if"
        hint="A question about the partner, asked before the reply. Failing it says the else line."
        on={option.if != null}
        onToggle={(on) =>
          ctx.update(path, (current) => {
            const { if: _dropped, ...rest } = current;
            return on ? { ...rest, if: DIALOG_CONDITIONS.carries.make(ctx.defaults) } : rest;
          })
        }
      >
        {option.if ? (
          <ConditionTreeEditor<DialogConditionDef>
            root={option.if}
            onChange={(next) => set({ if: next })}
            leaf={{
              render: (leaf, change) => <ConditionLeaf leaf={leaf} ctx={ctx} onChange={change} />,
              fresh: () => DIALOG_CONDITIONS.carries.make(ctx.defaults),
            }}
          />
        ) : null}
      </ToggledSection>

      <EffectsList
        effects={option.do ?? []}
        ctx={ctx}
        onChange={(effects) =>
          ctx.update(path, (current) => {
            const { do: _dropped, ...rest } = current;
            return effects.length ? { ...rest, do: effects } : rest;
          })
        }
      />

      {canRefuse ? (
        <Field label="Else" hint="Said instead when the condition fails or an effect is refused. Blank says nothing, which reads as a broken button.">
          <Textarea
            rows={2}
            value={option.else ?? ""}
            onChange={(e) =>
              ctx.update(path, (current) => {
                const { else: _dropped, ...rest } = current;
                return e.target.value ? { ...rest, else: e.target.value } : rest;
              })
            }
            aria-label="Else line"
          />
        </Field>
      ) : null}

      <ToggledSection
        label="Ask how many"
        hint="The NPC asks first, a stepper answers, and every count in the trade and the condition is multiplied."
        on={option.amount != null}
        onToggle={(on) =>
          ctx.update(path, (current) => {
            const { amount: _dropped, ...rest } = current;
            return on ? { ...rest, amount: { min: 1, max: 12, prompt: "How many?" } } : rest;
          })
        }
      >
        {option.amount ? (
          <AmountFields amount={option.amount} onChange={(amount) => set({ amount })} />
        ) : null}
      </ToggledSection>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase text-muted">Follow-ups</span>
        <span className="text-[11px] leading-snug text-muted">
          The buttons under this reply. None means the reply is a leaf: only Back.
        </span>
        <OptionList parent={path} options={option.then ?? []} depth={depth + 1} ctx={ctx} />
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[10px] font-bold uppercase text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-snug text-muted">{hint}</span> : null}
    </label>
  );
}

function ToggledSection({
  label,
  hint,
  on,
  onToggle,
  children,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-muted">
        <Switch checked={on} onCheckedChange={onToggle} ariaLabel={label} />
        {label}
      </label>
      {on ? children : <span className="text-[11px] leading-snug text-muted">{hint}</span>}
    </div>
  );
}

/** The condition picker and whatever that condition asks about. */
function ConditionLeaf({
  leaf,
  ctx,
  onChange,
}: {
  leaf: DialogConditionDef;
  ctx: EditorContext;
  onChange: (next: DialogConditionDef) => void;
}) {
  return (
    <>
      <Select
        value={leaf.cond}
        onValueChange={(v) =>
          v && onChange(DIALOG_CONDITIONS[v as DialogConditionDef["cond"]].make(ctx.defaults))
        }
        options={DIALOG_CONDITION_NAMES.map((name) => ({
          value: name,
          label: DIALOG_CONDITIONS[name].label,
        }))}
        className="min-w-[7rem]"
        ariaLabel="Condition"
      />
      {leaf.cond === "carries" || leaf.cond === "room_for" ? (
        <CountedTile side={leaf} options={ctx.itemOptions} onChange={(side) => onChange({ ...leaf, ...side })} />
      ) : leaf.cond === "has_tag" ? (
        <Input
          value={leaf.tag}
          onChange={(e) => onChange({ ...leaf, tag: e.target.value })}
          className="w-32"
          placeholder="tag"
          aria-label="Tag"
        />
      ) : (
        <Select
          value={leaf.statusId || null}
          onValueChange={(v) => v && onChange({ ...leaf, statusId: v })}
          options={ctx.statusOptions}
          placeholder="Status…"
          className="min-w-[8rem]"
          ariaLabel="Status"
        />
      )}
    </>
  );
}

/** A tile and how many of it — a trade side, or a counted condition. */
function CountedTile({
  side,
  options,
  onChange,
}: {
  side: TradeSide;
  options: Array<{ value: string; label: string }>;
  onChange: (next: TradeSide) => void;
}) {
  return (
    <>
      <Input
        type="number"
        min={1}
        max={MAX_DIALOG_AMOUNT}
        value={side.count}
        onChange={(e) => onChange({ ...side, count: Math.max(1, Number(e.target.value) || 1) })}
        className="w-16"
        aria-label="Count"
      />
      <Select
        value={side.tileId || null}
        onValueChange={(v) => v && onChange({ ...side, tileId: v })}
        options={options}
        placeholder="Tile…"
        className="min-w-[9rem]"
        ariaLabel="Tile"
      />
    </>
  );
}

function EffectsList({
  effects,
  ctx,
  onChange,
}: {
  effects: readonly DialogEffectDef[];
  ctx: EditorContext;
  onChange: (next: DialogEffectDef[]) => void;
}) {
  const replace = (i: number, next: DialogEffectDef) =>
    onChange(effects.map((effect, j) => (j === i ? next : effect)));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase text-muted">Does</span>
      {effects.map((effect, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select
            value={effect.effect}
            onValueChange={(v) =>
              v && replace(i, DIALOG_EFFECTS[v as DialogEffectDef["effect"]].make(ctx.defaults))
            }
            options={DIALOG_EFFECT_NAMES.map((name) => ({
              value: name,
              label: DIALOG_EFFECTS[name].label,
            }))}
            className="min-w-[7rem]"
            ariaLabel="Effect"
          />
          <EffectFields effect={effect} ctx={ctx} onChange={(next) => replace(i, next)} />
          <Button
            size="sm"
            variant="danger"
            onClick={() => onChange(effects.filter((_, j) => j !== i))}
            aria-label="Remove effect"
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 whitespace-nowrap"
          onClick={() => onChange([...effects, DIALOG_EFFECTS.trade.make(ctx.defaults)])}
        >
          + effect
        </Button>
        {effects.length === 0 ? (
          <span className="text-[11px] leading-snug text-muted">
            What pressing this does to the partner — a trade, a status, a tag. All or nothing.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EffectFields({
  effect,
  ctx,
  onChange,
}: {
  effect: DialogEffectDef;
  ctx: EditorContext;
  onChange: (next: DialogEffectDef) => void;
}) {
  if (effect.effect === "add_status") {
    return (
      <Select
        value={effect.statusId || null}
        onValueChange={(v) => v && onChange({ ...effect, statusId: v })}
        options={ctx.statusOptions}
        placeholder="Status…"
        className="min-w-[8rem]"
        ariaLabel="Status"
      />
    );
  }
  if (effect.effect === "tag") {
    return (
      <Input
        value={effect.tag}
        onChange={(e) => onChange({ ...effect, tag: e.target.value })}
        className="w-32"
        placeholder="tag"
        aria-label="Tag"
      />
    );
  }
  return (
    <div className="flex flex-col gap-1 border-2 border-border/40 p-1.5">
      <TradeSides
        label="Takes"
        sides={effect.take}
        ctx={ctx}
        onChange={(take) => onChange({ ...effect, take })}
      />
      <TradeSides
        label="Gives"
        sides={effect.give}
        ctx={ctx}
        onChange={(give) => onChange({ ...effect, give })}
      />
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
      <span className="w-10 text-[10px] font-bold uppercase text-muted">{label}</span>
      {sides.map((side, i) => (
        <span key={i} className="flex items-center gap-1">
          <CountedTile
            side={side}
            options={ctx.itemOptions}
            onChange={(next) => onChange(sides.map((s, j) => (j === i ? next : s)))}
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
        onClick={() => onChange([...sides, { tileId: ctx.defaults.tileId, count: 1 }])}
      >
        +
      </Button>
    </div>
  );
}

function AmountFields({
  amount,
  onChange,
}: {
  amount: DialogAmount;
  onChange: (next: DialogAmount) => void;
}) {
  const number = (key: "min" | "max") => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...amount, [key]: Math.max(1, Math.min(MAX_DIALOG_AMOUNT, Number(e.target.value) || 1)) });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase text-muted">
        <span>from</span>
        <Input type="number" min={1} max={MAX_DIALOG_AMOUNT} value={amount.min} onChange={number("min")} className="w-16" aria-label="Least" />
        <span>to</span>
        <Input type="number" min={1} max={MAX_DIALOG_AMOUNT} value={amount.max} onChange={number("max")} className="w-16" aria-label="Most" />
        <span>button</span>
        <Input
          value={amount.confirm ?? ""}
          onChange={(e) => {
            const { confirm: _dropped, ...rest } = amount;
            onChange(e.target.value ? { ...rest, confirm: e.target.value } : rest);
          }}
          className="w-28"
          placeholder={DEFAULT_CONFIRM_LABEL}
          aria-label="Confirm button label"
        />
      </div>
      <Field label="Asks" hint="What they say while waiting on the number.">
        <Textarea
          rows={1}
          value={amount.prompt}
          onChange={(e) => onChange({ ...amount, prompt: e.target.value })}
          aria-label="Amount prompt"
        />
      </Field>
    </div>
  );
}
