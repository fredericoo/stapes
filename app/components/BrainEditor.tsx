import {
  ANY_STATE,
  ATTACKER_SELECTOR,
  HOME_SELECTOR,
  SPEAKER_SELECTOR,
  isSelector,
  isSpeakerFilter,
  nearest,
  slot,
  slotTiles,
  thing,
  tilesNamedBy,
  validateBrain,
  type BrainActionDef,
  type BrainCondition,
  type BrainConditionDef,
  type BrainDef,
  type BrainEffectDef,
  type BrainStateDef,
  type BrainTransitionDef,
  type Selector,
  type SpeakerFilter,
} from "../lib/brain";
import {
  ACTIONS,
  ACTION_NAMES,
  CONDITIONS,
  CONDITION_NAMES,
  DEFAULT_SELECTOR,
  DEFAULT_THING,
  EFFECTS,
  EFFECT_NAMES,
  type ParamSpec,
  type TileFilter,
} from "../lib/brainCatalog";
import { PLAYER_TILE_ID } from "../game/constants";
import { resolveActor, type TileDef } from "../lib/types";
import { resolveBattler, type NaturalSpell } from "../lib/battler";
import { needsTarget } from "../game/casting";
import type { StatusDef } from "../lib/status";
import { resolveConsumable, resolveItem } from "../lib/item";
import { resolveExtract } from "../lib/interactions";
import { DragDropProvider } from "@dnd-kit/react";
import { ConditionTreeEditor } from "./ConditionTreeEditor";
import { DragHandle } from "./DragHandle";
import { EditorIssues } from "./EditorIssues";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Button, Input, NumberInput, Segmented, Select, Switch } from "../ui";

type Props = {
  brain: BrainDef | undefined;
  tiles: TileDef[];
  statusDefs: Record<string, StatusDef>;
  spells?: readonly BrainSpell[];
  onChange: (next: BrainDef | undefined) => void;
};

type BrainSpell = Pick<NaturalSpell, "name" | "effect">;

const EMPTY_BRAIN: BrainDef = {
  initial: "idle",
  states: { idle: { do: [{ action: "hold" }] } },
  transitions: [],
};

export function bodyTileIds(tiles: TileDef[]): string[] {
  const ids = tiles
    .filter((tile) => tile.id !== PLAYER_TILE_ID && resolveActor(tile))
    .map((tile) => tile.id)
    .sort();
  return [PLAYER_TILE_ID, ...ids];
}

export function thingTileIds(tiles: TileDef[]): string[] {
  return tiles
    .filter((tile) => !resolveActor(tile) && hasAnyInteraction(tile))
    .map((tile) => tile.id)
    .sort();
}

function hasAnyInteraction(tile: TileDef): boolean {
  return Object.keys(tile.interactions ?? {}).length > 0;
}

export function affordancesOf(tileId: string, tiles: TileDef[]): string[] {
  const tile = tiles.find((one) => one.id === tileId);
  if (!tile) return [];

  const verbs: string[] = [];
  const extract = resolveExtract(tile);
  if (extract?.actionName) verbs.push(extract.actionName.toLowerCase());
  if (resolveActor(tile) || resolveBattler(tile)) verbs.push("attack");
  return verbs;
}

export type SelectorKind = {
  key: string;
  label: string;
  make: () => Selector;
  tiles: TileOption[];
};

export type SelectorNames = { tiles: string[]; affords: string[] };

export type TileOption = { tileId: string; label: string };

export type Vocabulary = {
  kinds: SelectorKind[];
  tiles: Record<TileFilter, TileOption[]>;
  statuses: Array<{ value: string; label: string }>;
  spells: Array<{ value: string; label: string; self: boolean }>;
  describe(selector: Selector): SelectorNames | null;
};

export function selectorKindKey(selector: Selector): string {
  return selector.type === "slot" ? `$${selector.data.name}` : selector.type;
}

export function tileOptions(tiles: TileDef[]): Record<TileFilter, TileOption[]> {
  const items = tiles.filter((tile) => resolveItem(tile));
  return {
    item: items.map(tileOption),
    consumable: items.filter((tile) => resolveConsumable(tile)).map(tileOption),
  };
}

function tileOption(tile: TileDef): TileOption {
  return { tileId: tile.id, label: tile.name || tile.id };
}

export function selectorVocabulary(
  brain: BrainDef,
  tiles: TileDef[],
  statusDefs: Record<string, StatusDef> = {},
  spells: readonly BrainSpell[] = [],
): Vocabulary {
  const named = new Map(tiles.map((tile) => [tile.id, tile.name || tile.id]));
  const nameOf = (tileId: string) => named.get(tileId) ?? tileId;
  const bodies = bodyTileIds(tiles).map((tileId) => ({
    tileId,
    label: nameOf(tileId),
  }));
  const things = thingTileIds(tiles).map((tileId) => ({
    tileId,
    label: nameOf(tileId),
  }));

  const kinds: SelectorKind[] = [
    {
      key: "nearest",
      label: "nearest body",
      make: () => nearest(PLAYER_TILE_ID),
      tiles: bodies,
    },
    {
      key: "thing",
      label: "nearest thing",
      make: () => thing(things[0]?.tileId ?? PLAYER_TILE_ID),
      tiles: things,
    },
    { key: "speaker", label: "speaker", make: () => SPEAKER_SELECTOR, tiles: [] },
    { key: "attacker", label: "attacker", make: () => ATTACKER_SELECTOR, tiles: [] },
    { key: "home", label: "home", make: () => HOME_SELECTOR, tiles: [] },
  ];

  const slots = new Set<string>();
  for (const t of brain.transitions) {
    for (const name of Object.keys(t.bind ?? {})) slots.add(name);
  }
  for (const name of slots) {
    kinds.push({
      key: `$${name}`,
      label: `$${name}`,
      make: () => slot(name),
      tiles: [],
    });
  }

  const describe = (selector: Selector): SelectorNames | null => {
    const tileIds =
      selector.type === "slot" ? slotTiles(brain, selector.data.name) : tilesNamedBy(selector);
    if (tileIds.length === 0) return null;
    return {
      tiles: tileIds.map(nameOf),
      affords: [...new Set(tileIds.flatMap((tileId) => affordancesOf(tileId, tiles)))],
    };
  };

  return {
    kinds,
    tiles: tileOptions(tiles),
    statuses: Object.values(statusDefs).map((def) => ({
      value: def.id,
      label: def.name,
    })),
    spells: spells.map((spell, index) => ({
      value: String(index + 1),
      label: `${index + 1} — ${spell.name.trim() || "unnamed"}`,
      self: !needsTarget(spell),
    })),
    describe,
  };
}

export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function onSortEnd<T>(
  event: Parameters<NonNullable<React.ComponentProps<typeof DragDropProvider>["onDragEnd"]>>[0],
  list: T[],
  apply: (next: T[]) => void,
) {
  if (event.canceled) return;
  const { source } = event.operation;
  if (!isSortable(source)) return;
  const { initialIndex, index } = source;
  if (initialIndex === index) return;
  apply(arrayMove(list, initialIndex, index));
}

export function renamedState(brain: BrainDef, oldName: string, newName: string): BrainDef {
  const states: Record<string, BrainStateDef> = {};
  for (const [name, state] of Object.entries(brain.states)) {
    states[name === oldName ? newName : name] = state;
  }
  const remap = (n: string) => (n === oldName ? newName : n);
  return {
    initial: remap(brain.initial),
    states,
    transitions: brain.transitions.map((t) => ({
      ...t,
      from: t.from === ANY_STATE ? t.from : remap(t.from),
      to: remap(t.to),
    })),
  };
}

export function BrainEditor({ brain, tiles, statusDefs, spells = [], onChange }: Props) {
  if (!brain) {
    return (
      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <p className="text-[11px] leading-snug text-muted">
          None. A brain is a state machine that drives the body when nobody is connected to it, and
          makes the tile an Actor.
        </p>
        <Button size="sm" className="w-fit" onClick={() => onChange(EMPTY_BRAIN)}>
          Add brain
        </Button>
      </div>
    );
  }

  const stateNames = Object.keys(brain.states);
  const vocab = selectorVocabulary(brain, tiles, statusDefs, spells);
  const issues = validateBrain(brain);

  const setState = (name: string, next: BrainStateDef) => {
    onChange({ ...brain, states: { ...brain.states, [name]: next } });
  };

  const addState = () => {
    let name = "state";
    for (let i = 2; Object.hasOwn(brain.states, name); i++) name = `state-${i}`;
    onChange({ ...brain, states: { ...brain.states, [name]: { do: [{ action: "hold" }] } } });
  };

  const removeState = (name: string) => {
    const states = { ...brain.states };
    delete states[name];
    onChange({ ...brain, states });
  };

  return (
    <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
      <EditorIssues issues={issues} />

      <label className="flex items-center gap-2 text-xs">
        <span className="font-bold uppercase text-muted">Initial state</span>
        <Select
          value={brain.initial || null}
          onValueChange={(v) => v && onChange({ ...brain, initial: v })}
          options={stateNames.map((n) => ({ value: n, label: n }))}
          placeholder="Pick one…"
        />
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase text-muted">States</span>
          <Button size="sm" variant="secondary" onClick={addState}>
            Add state
          </Button>
        </div>
        {stateNames.map((name) => (
          <StateCard
            key={name}
            name={name}
            state={brain.states[name]!}
            vocab={vocab}
            taken={stateNames}
            onRename={(next) => onChange(renamedState(brain, name, next))}
            onChange={(next) => setState(name, next)}
            onRemove={stateNames.length > 1 ? () => removeState(name) : undefined}
          />
        ))}
      </div>

      <TransitionsTable
        brain={brain}
        stateNames={stateNames}
        vocab={vocab}
        onChange={(transitions) => onChange({ ...brain, transitions })}
      />

      <Button size="sm" variant="danger" className="w-fit" onClick={() => onChange(undefined)}>
        Remove brain
      </Button>
    </div>
  );
}

function StateCard({
  name,
  state,
  vocab,
  taken,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  state: BrainStateDef;
  vocab: Vocabulary;
  taken: string[];
  onRename: (next: string) => void;
  onChange: (next: BrainStateDef) => void;
  onRemove?: () => void;
}) {
  const rename = (next: string) => {
    const clean = next.trim();
    if (!clean || clean === name || taken.includes(clean)) return;
    onRename(clean);
  };

  return (
    <div className="flex flex-col gap-2 border-2 border-border bg-paper p-2">
      <div className="flex items-center gap-2">
        <Input
          defaultValue={name}
          onBlur={(e) => rename(e.target.value)}
          className="w-40 font-bold"
          aria-label="State name"
        />
        {onRemove ? (
          <Button size="sm" variant="danger" className="ml-auto" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>

      <EmitField emit={state.emit} onChange={(emit) => onChange({ ...state, emit })} />

      <VerbList
        title="On enter (effects)"
        items={state.onEnter ?? []}
        names={EFFECT_NAMES}
        registry={EFFECTS}
        discriminant="effect"
        vocab={vocab}
        onChange={(onEnter) =>
          onChange({ ...state, onEnter: onEnter.length ? onEnter : undefined })
        }
      />

      <VerbList
        title="Do (actions, in priority order)"
        items={state.do}
        names={ACTION_NAMES}
        registry={ACTIONS}
        discriminant="action"
        vocab={vocab}
        onChange={(next) => onChange({ ...state, do: next })}
      />
    </div>
  );
}

function EmitField({
  emit,
  onChange,
}: {
  emit: BrainStateDef["emit"];
  onChange: (next: BrainStateDef["emit"]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs font-bold">
        <Switch
          checked={Boolean(emit)}
          onCheckedChange={(on) => onChange(on ? { channel: "alarm", value: "on" } : undefined)}
          ariaLabel="Emit a signal while in this state"
        />
        Emit while in this state
      </label>
      {emit ? (
        <div className="flex flex-wrap items-center gap-2 pl-1 text-xs">
          <span className="uppercase text-muted">channel</span>
          <Input
            value={emit.channel}
            onChange={(e) => onChange({ ...emit, channel: e.target.value })}
            className="w-32"
            placeholder="alarm"
            aria-label="Emit channel"
          />
          <Segmented
            value={emit.value}
            onChange={(value) => onChange({ ...emit, value })}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            size="sm"
            ariaLabel="Emit value"
          />
        </div>
      ) : null}
    </div>
  );
}

function VerbList<T extends BrainActionDef | BrainEffectDef>({
  title,
  items,
  names,
  registry,
  discriminant,
  vocab,
  onChange,
}: {
  title: string;
  items: T[];
  names: string[];
  registry: Record<string, { label: string; hint: string; params: ParamSpec[]; make: () => T }>;
  discriminant: "action" | "effect";
  vocab: Vocabulary;
  onChange: (next: T[]) => void;
}) {
  const add = () => onChange([...items, registry[names[0]!]!.make()]);
  const set = (i: number, next: T) => onChange(items.map((it, j) => (j === i ? next : it)));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase text-muted">{title}</span>
        <Button size="sm" variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
      <DragDropProvider onDragEnd={(event) => onSortEnd(event, items, onChange)}>
        <div className="flex flex-col gap-1">
          {items.map((item, i) => (
            <VerbRow
              key={i}
              id={String(i)}
              index={i}
              value={item}
              names={names}
              registry={registry}
              discriminant={discriminant}
              vocab={vocab}
              onChange={(next) => set(i, next)}
              onRemove={() => onChange(items.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      </DragDropProvider>
    </div>
  );
}

function VerbRow<T extends BrainActionDef | BrainEffectDef>({
  id,
  index,
  value,
  names,
  registry,
  discriminant,
  vocab,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  value: T;
  names: string[];
  registry: Record<string, { label: string; hint: string; params: ParamSpec[]; make: () => T }>;
  discriminant: "action" | "effect";
  vocab: Vocabulary;
  onChange: (next: T) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });
  const current = (value as Record<string, string>)[discriminant]!;
  const spec = registry[current]!;

  return (
    <div
      ref={ref}
      className={[
        "flex flex-wrap items-center gap-2 bg-panel p-1.5",
        isDragging ? "opacity-60" : "",
      ].join(" ")}
    >
      <DragHandle handleRef={handleRef} label={`Drag to reorder line ${index + 1}`} />
      <span className="w-5 text-center font-mono text-[11px] text-muted">{index + 1}</span>
      <Select
        value={current}
        onValueChange={(v) => v && onChange(registry[v]!.make())}
        options={names.map((n) => ({ value: n, label: registry[n]!.label }))}
        className="min-w-[8rem]"
      />
      <ParamFields
        item={value as Record<string, unknown>}
        params={spec.params}
        vocab={vocab}
        onChange={(next) => onChange(next as T)}
      />
      <Button size="sm" variant="danger" onClick={onRemove} aria-label="Remove">
        ✕
      </Button>
    </div>
  );
}

function TransitionsTable({
  brain,
  stateNames,
  vocab,
  onChange,
}: {
  brain: BrainDef;
  stateNames: string[];
  vocab: Vocabulary;
  onChange: (next: BrainTransitionDef[]) => void;
}) {
  const items = brain.transitions;
  const add = () =>
    onChange([
      ...items,
      { from: ANY_STATE, if: CONDITIONS.after.make(), to: brain.initial || stateNames[0] || "" },
    ]);
  const set = (i: number, next: BrainTransitionDef) =>
    onChange(items.map((t, j) => (j === i ? next : t)));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase text-muted">
          Transitions (first match wins)
        </span>
        <Button size="sm" variant="secondary" onClick={add}>
          Add transition
        </Button>
      </div>
      <DragDropProvider onDragEnd={(event) => onSortEnd(event, items, onChange)}>
        <div className="flex flex-col gap-1">
          {items.map((t, i) => (
            <TransitionRow
              key={i}
              id={String(i)}
              index={i}
              transition={t}
              stateNames={stateNames}
              vocab={vocab}
              onChange={(next) => set(i, next)}
              onRemove={() => onChange(items.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      </DragDropProvider>
    </div>
  );
}

function TransitionRow({
  id,
  index,
  transition,
  stateNames,
  vocab,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  transition: BrainTransitionDef;
  stateNames: string[];
  vocab: Vocabulary;
  onChange: (next: BrainTransitionDef) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });
  const fromOptions = [ANY_STATE, ...stateNames].map((n) => ({ value: n, label: n }));
  const toOptions = stateNames.map((n) => ({ value: n, label: n }));

  return (
    <div
      ref={ref}
      className={["flex flex-col gap-1.5 bg-panel p-1.5", isDragging ? "opacity-60" : ""].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DragHandle handleRef={handleRef} label={`Drag to reorder transition ${index + 1}`} />
        <span className="w-5 text-center font-mono text-[11px] text-muted">{index + 1}</span>
        <span className="text-[10px] uppercase text-muted">from</span>
        <Select
          value={transition.from}
          onValueChange={(v) => v && onChange({ ...transition, from: v })}
          options={fromOptions}
          className="min-w-[6rem]"
        />
        <BindField transition={transition} vocab={vocab} onChange={onChange} />
        <span className="text-[10px] uppercase text-muted">to</span>
        <Select
          value={transition.to || null}
          onValueChange={(v) => v && onChange({ ...transition, to: v })}
          options={toOptions}
          className="min-w-[6rem]"
          placeholder="…"
        />
        <Button size="sm" variant="danger" onClick={onRemove} aria-label="Remove transition">
          ✕
        </Button>
      </div>
      <div className="flex items-start gap-2 pl-7">
        <span className="pt-1.5 text-[10px] uppercase text-muted">if</span>
        <ConditionTree
          root={transition.if}
          vocab={vocab}
          onChange={(next) => onChange({ ...transition, if: next })}
        />
      </div>
    </div>
  );
}

function ConditionTree({
  root,
  vocab,
  onChange,
}: {
  root: BrainCondition;
  vocab: Vocabulary;
  onChange: (next: BrainCondition) => void;
}) {
  return (
    <ConditionTreeEditor<BrainConditionDef>
      root={root}
      onChange={onChange}
      leaf={{
        render: (leaf, set) => <LeafFields leaf={leaf} vocab={vocab} onChange={set} />,
        fresh: () => CONDITIONS.after.make(),
      }}
    />
  );
}

function LeafFields({
  leaf,
  vocab,
  onChange,
}: {
  leaf: BrainConditionDef;
  vocab: Vocabulary;
  onChange: (next: BrainConditionDef) => void;
}) {
  return (
    <>
      <Select
        value={leaf.cond}
        onValueChange={(v) => v && onChange(CONDITIONS[v as BrainConditionDef["cond"]].make())}
        options={CONDITION_NAMES.map((n) => ({
          value: n,
          label: CONDITIONS[n].label,
        }))}
        className="min-w-[7rem]"
      />
      <ParamFields
        item={leaf as unknown as Record<string, unknown>}
        params={CONDITIONS[leaf.cond].params}
        vocab={vocab}
        onChange={(next) => onChange(next as unknown as BrainConditionDef)}
      />
    </>
  );
}

function BindField({
  transition,
  vocab,
  onChange,
}: {
  transition: BrainTransitionDef;
  vocab: Vocabulary;
  onChange: (next: BrainTransitionDef) => void;
}) {
  const entry = Object.entries(transition.bind ?? {})[0];
  const slotName = entry?.[0] ?? "";
  const source = entry?.[1] ?? DEFAULT_SELECTOR;

  const set = (nextSlot: string, nextSource: Selector) => {
    const clean = nextSlot.trim();
    const { bind: _drop, ...rest } = transition;
    if (!clean) {
      onChange(rest);
      return;
    }
    onChange({ ...rest, bind: { [clean]: nextSource } });
  };

  return (
    <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
      bind
      <Input
        value={slotName}
        onChange={(e) => set(e.target.value, source)}
        className="w-20"
        placeholder="(none)"
        aria-label="Bind slot name"
      />
      {slotName ? (
        <SelectorPicker
          value={source}
          vocab={vocab}
          onChange={(next) => set(slotName, next)}
          className="min-w-[6rem]"
        />
      ) : null}
    </label>
  );
}

function SelectorPicker({
  value,
  vocab,
  onChange,
  onClear,
  className,
}: {
  value: Selector | null;
  vocab: Vocabulary;
  onChange: (next: Selector) => void;
  onClear?: () => void;
  className?: string;
}) {
  const key = value ? selectorKindKey(value) : NO_TARGET_KEY;
  const kind = vocab.kinds.find((one) => one.key === key);
  const missing = value && !kind ? [{ key, label: `${key} (missing)` }] : [];
  const none = onClear ? [{ key: NO_TARGET_KEY, label: NO_TARGET_LABEL }] : [];
  const rows = [...none, ...missing, ...vocab.kinds];

  return (
    <>
      <Select
        value={key}
        onValueChange={(next) => {
          if (next === NO_TARGET_KEY) return onClear?.();
          const picked = vocab.kinds.find((one) => one.key === next);
          if (picked) onChange(picked.make());
        }}
        options={rows.map((one) => ({ value: one.key, label: one.label }))}
        className={className}
      />
      {value && kind && kind.tiles.length > 0 ? (
        <TileChips
          picked={tilesNamedBy(value)}
          options={kind.tiles}
          onChange={(tileIds) => onChange({ ...value, data: { tileIds } } as Selector)}
        />
      ) : null}
      {value ? <Affordances names={vocab.describe(value)} /> : null}
    </>
  );
}

const NO_TARGET_LABEL = "No target (self)";
const NO_TARGET_KEY = "";

function TileChips({
  picked,
  options,
  onChange,
}: {
  picked: readonly string[];
  options: TileOption[];
  onChange: (tileIds: string[]) => void;
}) {
  const ADD = "";
  const chosen = new Set(picked);
  const labels = new Map(options.map((one) => [one.tileId, one.label]));
  const spare = options.filter((one) => !chosen.has(one.tileId));

  return (
    <span className="flex flex-wrap items-center gap-1">
      {picked.map((tileId) => (
        <button
          key={tileId}
          type="button"
          onClick={() => onChange(picked.filter((one) => one !== tileId))}
          disabled={picked.length === 1}
          className="border-2 border-border bg-paper px-1 text-[11px] disabled:opacity-60"
          aria-label={
            picked.length === 1
              ? `${labels.get(tileId) ?? tileId} — the only tile, so it cannot be removed`
              : `Remove ${labels.get(tileId) ?? tileId}`
          }
        >
          {labels.get(tileId) ?? `${tileId} (missing)`}
          {picked.length > 1 ? " ✕" : ""}
        </button>
      ))}
      {spare.length > 0 ? (
        <Select
          value={ADD}
          onValueChange={(tileId) => tileId && onChange([...picked, tileId])}
          options={[
            { value: ADD, label: "+ tile" },
            ...spare.map((one) => ({ value: one.tileId, label: one.label })),
          ]}
          className="min-w-[5rem]"
          placeholder="+ tile"
          ariaLabel="Add a tile to this selector"
        />
      ) : null}
    </span>
  );
}

function Affordances({ names }: { names: SelectorNames | null }) {
  if (!names) return null;
  return (
    <span className="text-[10px] text-muted" title="What this selector names">
      {names.tiles.join(", ")}
      {names.affords.length > 0 ? ` · ${names.affords.join(", ")}` : ""}
    </span>
  );
}

function ParamFields({
  item,
  params,
  vocab,
  onChange,
}: {
  item: Record<string, unknown>;
  params: ParamSpec[];
  vocab: Vocabulary;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <>
      {params.map((spec) => (
        <ParamField
          key={spec.key}
          spec={spec}
          value={item[spec.key]}
          selfCast={spec.kind === "aim" && castsOnSelf(item[spec.spell], vocab)}
          vocab={vocab}
          onChange={(value) => onChange(dropSelfAims(paramPatch(item, spec, value), params, vocab))}
        />
      ))}
    </>
  );
}

function castsOnSelf(position: unknown, vocab: Vocabulary): boolean {
  return vocab.spells.some((spell) => spell.self && spell.value === String(position));
}

export function dropSelfAims(
  item: Record<string, unknown>,
  params: ParamSpec[],
  vocab: Vocabulary,
): Record<string, unknown> {
  const stale = params.filter(
    (spec) => spec.kind === "aim" && spec.key in item && castsOnSelf(item[spec.spell], vocab),
  );
  if (stale.length === 0) return item;
  const next = { ...item };
  for (const spec of stale) delete next[spec.key];
  return next;
}

export function paramPatch(
  item: Record<string, unknown>,
  spec: ParamSpec,
  value: unknown,
): Record<string, unknown> {
  const next = { ...item };
  const cleared =
    value === undefined ||
    (spec.kind === "boolean" && value === false) ||
    (spec.kind === "text" && spec.optional === true && value === "");
  if (cleared) delete next[spec.key];
  else next[spec.key] = value;
  return next;
}

function ParamField({
  spec,
  value,
  selfCast,
  vocab,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  selfCast: boolean;
  vocab: Vocabulary;
  onChange: (value: unknown) => void;
}) {
  if (spec.kind === "boolean") {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        <Switch checked={Boolean(value)} onCheckedChange={onChange} ariaLabel={spec.label} />
        {spec.label}
      </label>
    );
  }
  if (spec.kind === "selector") {
    return (
      <SelectorPicker
        value={isSelector(value) ? value : DEFAULT_SELECTOR}
        vocab={vocab}
        onChange={onChange}
        className="min-w-[7rem]"
      />
    );
  }
  if (spec.kind === "speaker") {
    return (
      <SpeakerFilterField
        spec={spec}
        value={isSpeakerFilter(value) ? value : null}
        vocab={vocab}
        onChange={onChange}
      />
    );
  }
  if (spec.kind === "status") {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        {spec.label}
        <Select
          value={typeof value === "string" ? value : null}
          onValueChange={(id) => onChange(id ?? undefined)}
          options={vocab.statuses}
          className="min-w-[7rem]"
          placeholder="Pick one…"
        />
      </label>
    );
  }
  if (spec.kind === "spell") {
    if (vocab.spells.length === 0) {
      return <span className="text-[10px] uppercase text-muted">no spells on this body</span>;
    }
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        {spec.label}
        <Select
          value={typeof value === "number" ? String(value) : null}
          onValueChange={(position) => position && onChange(Number(position))}
          options={vocab.spells}
          className="min-w-[7rem]"
          placeholder="Pick one…"
        />
      </label>
    );
  }
  if (spec.kind === "ground") {
    return (
      <GroundField
        spec={spec}
        value={isSelector(value) ? value : null}
        vocab={vocab}
        onChange={onChange}
      />
    );
  }
  if (spec.kind === "aim") {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        {spec.label}
        {selfCast ? (
          <span>{NO_TARGET_LABEL}</span>
        ) : (
          <SelectorPicker
            value={isSelector(value) ? value : null}
            vocab={vocab}
            onChange={onChange}
            onClear={() => onChange(undefined)}
            className="min-w-[7rem]"
          />
        )}
      </label>
    );
  }
  if (spec.kind === "tile") {
    return (
      <TilePicker
        spec={spec}
        value={typeof value === "string" ? value : null}
        options={vocab.tiles[spec.tiles]}
        onChange={onChange}
      />
    );
  }
  if (spec.kind === "number") {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        {spec.label}
        <NumberInput
          min={spec.min}
          max={spec.max}
          value={typeof value === "number" ? value : 0}
          onChange={onChange}
          className="w-20"
          aria-label={spec.label}
        />
      </label>
    );
  }
  return (
    <Input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      className="w-28"
      placeholder={spec.optional ? "any" : spec.label}
      aria-label={spec.label}
    />
  );
}

function GroundField({
  spec,
  value,
  vocab,
  onChange,
}: {
  spec: ParamSpec;
  value: Selector | null;
  vocab: Vocabulary;
  onChange: (value: Selector | undefined) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
      {spec.label}
      <Switch
        checked={value !== null}
        ariaLabel={spec.label}
        onCheckedChange={(on) => onChange(on ? DEFAULT_THING : undefined)}
      />
      {value ? <SelectorPicker value={value} vocab={vocab} onChange={onChange} /> : null}
    </label>
  );
}

function TilePicker({
  spec,
  value,
  options,
  onChange,
}: {
  spec: Extract<ParamSpec, { kind: "tile" }>;
  value: string | null;
  options: TileOption[];
  onChange: (value: string | undefined) => void;
}) {
  const ANYTHING = "";
  const known = value === null || options.some((one) => one.tileId === value);
  const rows = [
    ...(spec.optional ? [{ value: ANYTHING, label: "anything" }] : []),
    ...(known ? [] : [{ value, label: `${value} (missing)` }]),
    ...options.map((one) => ({ value: one.tileId, label: one.label })),
  ];

  return (
    <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
      {spec.label}
      <Select
        value={value ?? ANYTHING}
        onValueChange={(next) => onChange(next ? next : undefined)}
        options={rows}
        className="min-w-[7rem]"
        placeholder="anything"
      />
    </label>
  );
}

function SpeakerFilterField({
  spec,
  value,
  vocab,
  onChange,
}: {
  spec: ParamSpec;
  value: SpeakerFilter | null;
  vocab: Vocabulary;
  onChange: (value: SpeakerFilter | undefined) => void;
}) {
  const ANYBODY = "anybody";

  return (
    <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
      {spec.label}
      <Select
        value={value?.match ?? ANYBODY}
        onValueChange={(next) => {
          if (next === null || next === ANYBODY) return onChange(undefined);
          onChange({
            match: next as SpeakerFilter["match"],
            of: value?.of ?? DEFAULT_SELECTOR,
          });
        }}
        options={[
          { value: ANYBODY, label: "anybody" },
          { value: "is", label: "is" },
          { value: "not", label: "is not" },
        ]}
        className="min-w-[6rem]"
      />
      {value ? (
        <SelectorPicker
          value={value.of}
          vocab={vocab}
          onChange={(of) => onChange({ ...value, of })}
          className="min-w-[7rem]"
        />
      ) : null}
    </label>
  );
}
