import {
  ANY_STATE,
  ATTACKER_SELECTOR,
  HOME_SELECTOR,
  SPEAKER_SELECTOR,
  fromStates,
  isSelector,
  isSpeakerFilter,
  nearest,
  needsExpansion,
  slot,
  slotTiles,
  thing,
  tilesNamedBy,
  type BrainActionDef,
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
import {
  BANDS,
  KIND_LABELS,
  PARAM_KINDS,
  REST_STATE,
  checkBrain,
  expandBrain,
  fits,
  isArgRef,
  isCall,
  type ArgRef,
  type AuthoredBrain,
  type AuthoredCondition,
  type AuthoredStateDef,
  type AuthoredTransitionDef,
  type Band,
  type BrainTriggerDef,
  type ParamKind,
  type TraitCall,
  type TraitCatalogue,
  type TraitContext,
  type TraitLet,
  type TraitParam,
} from "../lib/traits";
import { PLAYER_TILE_ID } from "../game/constants";
import { resolveActor, type TileDef } from "../lib/types";
import { resolveBattler, type NaturalSpell } from "../lib/battler";
import { needsTarget } from "../game/casting";
import type { StatusDef } from "../lib/status";
import { resolveConsumable, resolveItem } from "../lib/item";
import { resolveExtract } from "../lib/interactions";
import { DragDropProvider } from "@dnd-kit/react";
import {
  describeActions,
  describeCondition,
  describeEffects,
  describeFrom,
  describeSelector,
} from "./brainText";
import { ConditionTreeEditor } from "./ConditionTreeEditor";
import { DragHandle } from "./DragHandle";
import { EditorIssues } from "./EditorIssues";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Button, Input, NumberInput, OptionalNumberInput, Segmented, Select, Switch } from "../ui";

type Props = {
  brain: AuthoredBrain | undefined;
  tiles: TileDef[];
  statusDefs: Record<string, StatusDef>;
  spells?: readonly BrainSpell[];
  traits?: TraitCatalogue;
  onChange: (next: AuthoredBrain | undefined) => void;
};

type BrainSpell = Pick<NaturalSpell, "name" | "effect">;

const EMPTY_BRAIN: AuthoredBrain = {
  initial: "idle",
  states: { idle: { do: [{ action: "hold" }] } },
  transitions: [],
};

const NO_TRAITS: TraitCatalogue = {};

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

export function traitContext(
  tiles: TileDef[],
  statusDefs: Record<string, StatusDef>,
  spells: readonly unknown[] = [],
): TraitContext {
  const options = tileOptions(tiles);
  return {
    bodies: new Set(bodyTileIds(tiles)),
    things: new Set(thingTileIds(tiles)),
    items: new Set(options.item.map((one) => one.tileId)),
    consumables: new Set(options.consumable.map((one) => one.tileId)),
    statuses: new Set(Object.keys(statusDefs)),
    spells: spells.length,
  };
}

/**
 * `slotNames` is for a brain built from traits: `brain` is then its expanded
 * table, whose binds say what a slot holds but also carry every call's private
 * slots, which the brain itself cannot name.
 */
export function selectorVocabulary(
  brain: BrainDef,
  tiles: TileDef[],
  statusDefs: Record<string, StatusDef> = {},
  spells: readonly BrainSpell[] = [],
  slotNames?: Iterable<string>,
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

  const slots = new Set<string>(slotNames);
  if (slotNames === undefined) {
    for (const t of brain.transitions) {
      for (const name of Object.keys(t.bind ?? {})) slots.add(name);
    }
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

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function mapValues(
  record: Record<string, unknown>,
  map: (value: unknown) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}

export function renamedState(
  brain: AuthoredBrain,
  oldName: string,
  newName: string,
  catalogue: TraitCatalogue = NO_TRAITS,
): AuthoredBrain {
  const states: Record<string, AuthoredStateDef> = {};
  for (const [name, state] of Object.entries(brain.states)) {
    states[name === oldName ? newName : name] = state;
  }
  const remap = (n: string) => (n === oldName ? newName : n);
  const remapFrom = (from: BrainTransitionDef["from"]) => {
    if (typeof from !== "string") return from.map(remap);
    return from === ANY_STATE ? from : remap(from);
  };
  const remapState = (value: unknown): unknown => {
    if (typeof value === "string") return remap(value);
    return isCall(value) ? remapCall(value) : value;
  };
  const remapCall = (call: TraitCall): TraitCall => {
    const def = own(catalogue, call.trait);
    if (!def || !call.with) return call;
    const args = Object.fromEntries(
      Object.entries(call.with).map(([name, value]) => [
        name,
        own(def.params, name)?.kind === "state" ? remapState(value) : value,
      ]),
    );
    return { ...call, with: args };
  };
  const lets = brain.let
    ? Object.fromEntries(
        Object.entries(brain.let).map(([name, bound]) => [
          name,
          bound.kind === "state" ? { ...bound, value: remapState(bound.value) } : bound,
        ]),
      )
    : undefined;
  return {
    ...brain,
    initial: remap(brain.initial),
    states,
    transitions: brain.transitions.map((t) => ({ ...t, from: remapFrom(t.from), to: remap(t.to) })),
    ...(brain.triggers ? { triggers: brain.triggers.map((t) => ({ ...t, to: remap(t.to) })) } : {}),
    ...(brain.traits ? { traits: brain.traits.map(remapCall) } : {}),
    ...(lets ? { let: lets } : {}),
  };
}

/**
 * Walks every value in the brain rather than the positions a let may stand
 * in, because a let is named by `{ arg }` anywhere a value goes. A call's
 * `with` is itself a record of names, so only the values inside it are read.
 */
export function renamedLet(brain: AuthoredBrain, oldName: string, newName: string): AuthoredBrain {
  const swap = (value: unknown): unknown => {
    if (isArgRef(value)) return value.arg === oldName ? { arg: newName } : value;
    if (Array.isArray(value)) return value.map(swap);
    if (typeof value !== "object" || value === null) return value;
    if (isCall(value)) return value.with ? { ...value, with: mapValues(value.with, swap) } : value;
    return mapValues(value as Record<string, unknown>, swap);
  };
  const lets = Object.fromEntries(
    Object.entries(brain.let ?? {}).map(([name, bound]) => [
      name === oldName ? newName : name,
      { ...bound, value: swap(bound.value) },
    ]),
  );
  const { let: _lets, ...rest } = brain;
  return { ...(swap(rest) as AuthoredBrain), let: lets };
}

function brainSlots(brain: AuthoredBrain, catalogue: TraitCatalogue): string[] {
  const names = new Set<string>();
  for (const row of [...brain.transitions, ...(brain.triggers ?? [])]) {
    for (const name of Object.keys(row.bind ?? {})) names.add(name);
  }
  const visit = (call: TraitCall) => {
    const def = own(catalogue, call.trait);
    if (!def) return;
    for (const [name, value] of Object.entries(call.with ?? {})) {
      const kind = own(def.params, name)?.kind;
      if (kind === "slot" && typeof value === "string") names.add(value);
      if (kind === "state" && isCall(value)) visit(value);
    }
  };
  for (const call of brain.traits ?? []) visit(call);
  for (const bound of Object.values(brain.let ?? {})) {
    if (bound.kind === "state" && isCall(bound.value)) visit(bound.value);
  }
  return [...names];
}

type ArgScope = {
  catalogue: TraitCatalogue;
  states: string[];
  lets: Record<string, TraitLet>;
};

function conditionLets(lets: Record<string, TraitLet>): string[] {
  return Object.keys(lets).filter((name) => lets[name]!.kind === "condition");
}

export function BrainEditor({
  brain,
  tiles,
  statusDefs,
  spells = [],
  traits = NO_TRAITS,
  onChange,
}: Props) {
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
  const built = needsExpansion(brain);
  const expansion = built ? expandBrain(brain, traits) : null;
  const table = expansion?.table ?? (brain as BrainDef);
  const vocab = selectorVocabulary(
    table,
    tiles,
    statusDefs,
    spells,
    built ? brainSlots(brain, traits) : undefined,
  );
  const issues = checkBrain(brain, traits, traitContext(tiles, statusDefs, spells));
  const lets = brain.let ?? {};
  const scope: ArgScope = { catalogue: traits, states: [...stateNames, REST_STATE], lets };
  const offersTraits = Object.keys(traits).length > 0 || (brain.traits ?? []).length > 0;

  const setState = (name: string, next: AuthoredStateDef) => {
    onChange({ ...brain, states: { ...brain.states, [name]: next } });
  };

  const setOptional = <K extends "traits" | "triggers" | "let">(
    key: K,
    next: AuthoredBrain[K] | undefined,
  ) => {
    const { [key]: _drop, ...rest } = brain;
    const empty = next === undefined || Object.keys(next).length === 0;
    onChange((empty ? rest : { ...rest, [key]: next }) as AuthoredBrain);
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

      {offersTraits ? (
        <TraitCallList
          calls={brain.traits ?? []}
          scope={scope}
          vocab={vocab}
          onChange={(next) => setOptional("traits", next)}
        />
      ) : null}

      <LetList
        lets={lets}
        scope={scope}
        vocab={vocab}
        onChange={(next) => setOptional("let", next)}
        onRename={(from, to) => onChange(renamedLet(brain, from, to))}
      />

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
            taken={[...stateNames, REST_STATE]}
            showBand={built}
            held={expansion?.bands[name]}
            onRename={(next) => onChange(renamedState(brain, name, next, traits))}
            onChange={(next) => setState(name, next)}
            onRemove={stateNames.length > 1 ? () => removeState(name) : undefined}
          />
        ))}
      </div>

      <TriggerList
        triggers={brain.triggers ?? []}
        scope={scope}
        vocab={vocab}
        onChange={(next) => setOptional("triggers", next)}
      />

      <TransitionsTable
        brain={brain}
        stateNames={stateNames}
        lets={conditionLets(lets)}
        vocab={vocab}
        onChange={(transitions) => onChange({ ...brain, transitions })}
      />

      {expansion ? <ExpandedTable table={expansion.table} bands={expansion.bands} /> : null}

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
  showBand,
  held,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  state: AuthoredStateDef;
  vocab: Vocabulary;
  taken: string[];
  showBand: boolean;
  held?: Band;
  onRename: (next: string) => void;
  onChange: (next: AuthoredStateDef) => void;
  onRemove?: () => void;
}) {
  const rename = (next: string) => {
    const clean = next.trim();
    if (!clean || clean === name || taken.includes(clean)) return;
    onRename(clean);
  };

  const setBand = (band: string | null) => {
    const { band: _drop, ...rest } = state;
    onChange(band && band !== "idle" ? { ...rest, band: band as Band } : rest);
  };

  return (
    <div className="flex flex-col gap-2 border-2 border-border bg-paper p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          defaultValue={name}
          onBlur={(e) => rename(e.target.value)}
          className="w-40 font-bold"
          aria-label="State name"
        />
        {showBand ? (
          <label
            className="flex items-center gap-1 text-[10px] uppercase text-muted"
            title="A trigger takes the body out of this state only if it fires at a higher band."
          >
            band
            <Select
              value={state.band ?? "idle"}
              onValueChange={setBand}
              options={BANDS.map((band) => ({ value: band, label: band }))}
              className="min-w-[6rem]"
              ariaLabel="Band this state holds at"
            />
          </label>
        ) : null}
        {showBand && held && held !== (state.band ?? "idle") ? (
          <span className="text-[10px] text-muted">
            holds at {held}: a trait it is handed to raises it
          </span>
        ) : null}
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
  lets,
  vocab,
  onChange,
}: {
  brain: AuthoredBrain;
  stateNames: string[];
  lets: readonly string[];
  vocab: Vocabulary;
  onChange: (next: AuthoredTransitionDef[]) => void;
}) {
  const items = brain.transitions;
  const add = () =>
    onChange([
      ...items,
      { from: ANY_STATE, if: CONDITIONS.after.make(), to: brain.initial || stateNames[0] || "" },
    ]);
  const set = (i: number, next: AuthoredTransitionDef) =>
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
              lets={lets}
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
  lets,
  vocab,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  transition: AuthoredTransitionDef;
  stateNames: string[];
  lets: readonly string[];
  vocab: Vocabulary;
  onChange: (next: AuthoredTransitionDef) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });
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
        <FromField
          from={transition.from}
          stateNames={stateNames}
          onChange={(from) => onChange({ ...transition, from })}
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
          lets={lets}
          vocab={vocab}
          onChange={(next) => onChange({ ...transition, if: next })}
        />
      </div>
    </div>
  );
}

function FromField({
  from,
  stateNames,
  onChange,
}: {
  from: BrainTransitionDef["from"];
  stateNames: string[];
  onChange: (next: BrainTransitionDef["from"]) => void;
}) {
  const ADD = "";
  const listed = fromStates(from);
  const spare = stateNames.filter((name) => !listed.includes(name));
  const adder =
    from !== ANY_STATE && spare.length > 0 ? (
      <Select
        value={ADD}
        onValueChange={(name) => name && onChange([...listed, name])}
        options={[
          { value: ADD, label: "+ state" },
          ...spare.map((name) => ({ value: name, label: name })),
        ]}
        className="min-w-[5rem]"
        placeholder="+ state"
        ariaLabel="Add a state this transition leaves from"
      />
    ) : null;

  if (typeof from === "string") {
    return (
      <>
        <Select
          value={from}
          onValueChange={(v) => v && onChange(v)}
          options={[ANY_STATE, ...stateNames].map((n) => ({ value: n, label: n }))}
          className="min-w-[6rem]"
        />
        {adder}
      </>
    );
  }

  const remove = (name: string) => {
    const kept = from.filter((one) => one !== name);
    onChange(kept.length === 1 ? kept[0]! : kept);
  };

  return (
    <span className="flex flex-wrap items-center gap-1">
      {from.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => remove(name)}
          disabled={from.length === 1}
          className="border-2 border-border bg-paper px-1 text-[11px] disabled:opacity-60"
          aria-label={
            from.length === 1
              ? `${name} — the only state, so it cannot be removed`
              : `Stop leaving from ${name}`
          }
        >
          {name}
          {from.length > 1 ? " ✕" : ""}
        </button>
      ))}
      {adder}
    </span>
  );
}

function ConditionTree({
  root,
  lets,
  vocab,
  onChange,
}: {
  root: AuthoredCondition;
  lets: readonly string[];
  vocab: Vocabulary;
  onChange: (next: AuthoredCondition) => void;
}) {
  return (
    <ConditionTreeEditor<BrainConditionDef | ArgRef>
      root={root}
      onChange={onChange}
      leaf={{
        render: (leaf, set) => <LeafFields leaf={leaf} lets={lets} vocab={vocab} onChange={set} />,
        fresh: () => CONDITIONS.after.make(),
      }}
    />
  );
}

const LET_OPTION = "let:";

function LeafFields({
  leaf,
  lets,
  vocab,
  onChange,
}: {
  leaf: BrainConditionDef | ArgRef;
  lets: readonly string[];
  vocab: Vocabulary;
  onChange: (next: BrainConditionDef | ArgRef) => void;
}) {
  const missing = isArgRef(leaf) && !lets.includes(leaf.arg) ? [leaf.arg] : [];
  const letOptions = [...lets, ...missing].map((name) => ({
    value: `${LET_OPTION}${name}`,
    label: missing.includes(name) ? `${name} (missing)` : `let ${name}`,
  }));

  return (
    <>
      <Select
        value={isArgRef(leaf) ? `${LET_OPTION}${leaf.arg}` : leaf.cond}
        onValueChange={(v) => {
          if (!v) return;
          if (v.startsWith(LET_OPTION)) onChange({ arg: v.slice(LET_OPTION.length) });
          else onChange(CONDITIONS[v as BrainConditionDef["cond"]].make());
        }}
        options={[
          ...CONDITION_NAMES.map((n) => ({ value: n, label: CONDITIONS[n].label })),
          ...letOptions,
        ]}
        className="min-w-[7rem]"
      />
      {isArgRef(leaf) ? null : (
        <ParamFields
          item={leaf as unknown as Record<string, unknown>}
          params={CONDITIONS[leaf.cond].params}
          vocab={vocab}
          onChange={(next) => onChange(next as unknown as BrainConditionDef)}
        />
      )}
    </>
  );
}

function BindField<Row extends { bind?: Record<string, Selector> }>({
  transition,
  vocab,
  onChange,
}: {
  transition: Row;
  vocab: Vocabulary;
  onChange: (next: Row) => void;
}) {
  const entry = Object.entries(transition.bind ?? {})[0];
  const slotName = entry?.[0] ?? "";
  const source = entry?.[1] ?? DEFAULT_SELECTOR;

  const set = (nextSlot: string, nextSource: Selector) => {
    const clean = nextSlot.trim();
    const { bind: _drop, ...rest } = transition;
    if (!clean) {
      onChange(rest as Row);
      return;
    }
    onChange({ ...rest, bind: { [clean]: nextSource } } as Row);
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
  if (spec.kind === "number" && spec.optional) {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        {spec.label}
        <OptionalNumberInput
          min={spec.min}
          max={spec.max}
          value={typeof value === "number" ? value : undefined}
          onChange={onChange}
          className="w-20"
          placeholder="none"
          aria-label={spec.label}
        />
      </label>
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

const ADD_OPTION = "";

function TraitCallList({
  calls,
  scope,
  vocab,
  onChange,
}: {
  calls: TraitCall[];
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: TraitCall[]) => void;
}) {
  const traits = Object.values(scope.catalogue).sort((a, b) => a.name.localeCompare(b.name));
  const set = (i: number, next: TraitCall) => onChange(calls.map((c, j) => (j === i ? next : c)));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs font-bold uppercase text-muted"
          title="When two triggers fire at the same band, the one from the earlier trait wins."
        >
          Traits (earlier wins a tie)
        </span>
        <Select
          value={ADD_OPTION}
          placeholder="Add trait"
          onValueChange={(id) => id && onChange([...calls, { trait: id }])}
          options={[
            { value: ADD_OPTION, label: "Add trait" },
            ...traits.map((def) => ({ value: def.id, label: def.name })),
          ]}
          className="min-w-[8rem]"
          ariaLabel="Add a trait"
        />
      </div>
      {calls.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted">
          None. A trait brings its own states and the triggers that enter them, so a brain can fight
          back or sleep at night without writing either out.
        </p>
      ) : null}
      <DragDropProvider onDragEnd={(event) => onSortEnd(event, calls, onChange)}>
        <div className="flex flex-col gap-1">
          {calls.map((call, i) => (
            <TraitCallCard
              key={i}
              id={String(i)}
              index={i}
              call={call}
              scope={scope}
              vocab={vocab}
              onChange={(next) => set(i, next)}
              onRemove={() => onChange(calls.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      </DragDropProvider>
    </div>
  );
}

function TraitCallCard({
  id,
  index,
  call,
  scope,
  vocab,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  call: TraitCall;
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: TraitCall) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });
  const def = own(scope.catalogue, call.trait);
  const known = def !== undefined;
  const options = Object.values(scope.catalogue)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((one) => ({ value: one.id, label: one.name }));

  const pick = (next: string | null) => {
    const nextDef = next ? own(scope.catalogue, next) : undefined;
    if (!nextDef) return;
    const kept = Object.entries(call.with ?? {}).filter(
      ([name]) => own(nextDef.params, name)?.kind === own(def?.params ?? {}, name)?.kind,
    );
    onChange(
      kept.length > 0
        ? { trait: nextDef.id, with: Object.fromEntries(kept) }
        : { trait: nextDef.id },
    );
  };

  const setArg = (name: string, value: unknown) => {
    const args = { ...call.with };
    if (value === undefined) delete args[name];
    else args[name] = value;
    onChange(Object.keys(args).length > 0 ? { ...call, with: args } : { trait: call.trait });
  };

  return (
    <div
      ref={ref}
      className={["flex flex-col gap-1.5 bg-panel p-1.5", isDragging ? "opacity-60" : ""].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DragHandle handleRef={handleRef} label={`Drag to reorder trait ${index + 1}`} />
        <span className="w-5 text-center font-mono text-[11px] text-muted">{index + 1}</span>
        <Select
          value={call.trait}
          onValueChange={pick}
          options={
            known ? options : [{ value: call.trait, label: `${call.trait} (missing)` }, ...options]
          }
          className="min-w-[10rem]"
          ariaLabel="Trait"
        />
        <Button size="sm" variant="danger" onClick={onRemove} aria-label="Remove trait">
          ✕
        </Button>
      </div>
      {def ? (
        <>
          {def.hint ? <p className="pl-7 text-[11px] leading-snug text-muted">{def.hint}</p> : null}
          <div className="flex flex-col gap-1 pl-7">
            {Object.entries(def.params).map(([name, param]) => (
              <ArgField
                key={name}
                name={name}
                param={param}
                value={call.with?.[name]}
                scope={scope}
                vocab={vocab}
                onChange={(value) => setArg(name, value)}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="pl-7 text-[11px] leading-snug text-danger">
          There is no trait called {call.trait}. Pick another, or remove the call.
        </p>
      )}
    </div>
  );
}

const OWN_VALUE = "";

function ArgField({
  name,
  param,
  value,
  scope,
  vocab,
  onChange,
}: {
  name: string;
  param: TraitParam;
  value: unknown;
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: unknown) => void;
}) {
  const label = param.label ?? name;
  const named = param.kind === "state" || param.kind === "slot" || param.kind === "condition";
  const fitting = named
    ? []
    : Object.keys(scope.lets).filter((one) => fits(scope.lets[one]!.kind, param.kind));
  const settled = Object.hasOwn(param, "default") || param.optional === true;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="min-w-[6rem] text-[10px] uppercase text-muted"
        title={`${name}: ${KIND_LABELS[param.kind]}${param.optional ? ", optional" : ""}`}
      >
        {label}
      </span>
      {fitting.length > 0 ? (
        <Select
          value={isArgRef(value) ? value.arg : OWN_VALUE}
          onValueChange={(pick) => onChange(pick ? { arg: pick } : undefined)}
          options={[
            { value: OWN_VALUE, label: "own value" },
            ...fitting.map((one) => ({ value: one, label: `let ${one}` })),
          ]}
          className="min-w-[6rem]"
          ariaLabel={`Where ${label} comes from`}
        />
      ) : null}
      {isArgRef(value) && fitting.length > 0 ? null : (
        <ArgValue
          param={param}
          value={value}
          scope={scope}
          vocab={vocab}
          onChange={onChange}
          ariaLabel={label}
        />
      )}
      {value !== undefined && settled ? (
        <Button size="sm" variant="secondary" onClick={() => onChange(undefined)}>
          {Object.hasOwn(param, "default") ? "Use default" : "Clear"}
        </Button>
      ) : null}
    </div>
  );
}

const NUMBER_BOUNDS: Partial<Record<ParamKind, { min?: number; max?: number }>> = {
  cells: { min: 0 },
  ms: { min: 0 },
  percent: { min: 0, max: 100 },
  hour: { min: 0, max: 23 },
  level: {},
  steps: { min: 1 },
};

function ArgValue({
  param,
  value,
  scope,
  vocab,
  onChange,
  ariaLabel,
}: {
  param: Pick<TraitParam, "kind" | "default">;
  value: unknown;
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: unknown) => void;
  ariaLabel: string;
}) {
  const fallback = param.default;
  const hint = fallback === undefined ? "Pick one…" : String(fallback);
  const bounds = NUMBER_BOUNDS[param.kind];

  if (bounds) {
    return (
      <OptionalNumberInput
        value={typeof value === "number" ? value : undefined}
        onChange={onChange}
        min={bounds.min}
        max={bounds.max}
        step={1}
        placeholder={typeof fallback === "number" ? String(fallback) : ""}
        className="w-20"
        aria-label={ariaLabel}
      />
    );
  }

  switch (param.kind) {
    case "boolean":
      return (
        <Switch
          checked={typeof value === "boolean" ? value : fallback === true}
          onCheckedChange={onChange}
          ariaLabel={ariaLabel}
        />
      );
    case "text":
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={typeof fallback === "string" ? fallback : "none"}
          className="w-28"
          aria-label={ariaLabel}
        />
      );
    case "bodies":
    case "things": {
      const key = param.kind === "bodies" ? "nearest" : "thing";
      return (
        <TileChips
          picked={Array.isArray(value) ? value : []}
          options={vocab.kinds.find((one) => one.key === key)?.tiles ?? []}
          onChange={(tileIds) => onChange(tileIds.length > 0 ? tileIds : undefined)}
        />
      );
    }
    case "item":
    case "consumable":
      return (
        <Select
          value={typeof value === "string" ? value : null}
          onValueChange={(next) => onChange(next ?? undefined)}
          options={vocab.tiles[param.kind].map((one) => ({ value: one.tileId, label: one.label }))}
          placeholder={hint}
          className="min-w-[7rem]"
          ariaLabel={ariaLabel}
        />
      );
    case "status":
      return (
        <Select
          value={typeof value === "string" ? value : null}
          onValueChange={(next) => onChange(next ?? undefined)}
          options={vocab.statuses}
          placeholder={hint}
          className="min-w-[7rem]"
          ariaLabel={ariaLabel}
        />
      );
    case "spell":
      if (vocab.spells.length === 0) {
        return <span className="text-[10px] uppercase text-muted">no spells on this body</span>;
      }
      return (
        <Select
          value={typeof value === "number" ? String(value) : null}
          onValueChange={(next) => onChange(next ? Number(next) : undefined)}
          options={vocab.spells}
          placeholder={hint}
          className="min-w-[7rem]"
          ariaLabel={ariaLabel}
        />
      );
    case "band":
      return (
        <Select
          value={typeof value === "string" ? value : null}
          onValueChange={(next) => onChange(next ?? undefined)}
          options={BANDS.map((band) => ({ value: band, label: band }))}
          placeholder={hint}
          className="min-w-[6rem]"
          ariaLabel={ariaLabel}
        />
      );
    case "state":
      if (isCall(value)) {
        const routine = own(scope.catalogue, value.trait);
        return <span className="text-[11px]">runs {routine?.name ?? value.trait}</span>;
      }
      return (
        <Select
          value={typeof value === "string" ? value : null}
          onValueChange={(next) => onChange(next ?? undefined)}
          options={scope.states.map((name) => ({ value: name, label: name }))}
          placeholder={hint}
          className="min-w-[7rem]"
          ariaLabel={ariaLabel}
        />
      );
    case "slot":
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value.trim() || undefined)}
          placeholder="its own"
          className="w-24"
          aria-label={ariaLabel}
        />
      );
    case "selector":
      if (!isSelector(value)) {
        return (
          <Button size="sm" variant="secondary" onClick={() => onChange(DEFAULT_SELECTOR)}>
            Pick a target
          </Button>
        );
      }
      return <SelectorPicker value={value} vocab={vocab} onChange={onChange} />;
    case "condition":
      if (value === undefined) {
        return (
          <Button size="sm" variant="secondary" onClick={() => onChange(CONDITIONS.after.make())}>
            Add condition
          </Button>
        );
      }
      return (
        <ConditionTree
          root={value as AuthoredCondition}
          lets={conditionLets(scope.lets)}
          vocab={vocab}
          onChange={onChange}
        />
      );
    case "actions":
      if (!Array.isArray(value)) {
        const standing = Array.isArray(fallback) ? fallback : [{ action: "hold" }];
        return (
          <>
            <span className="text-[11px] text-muted">{describeActions(standing)}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onChange(structuredClone(standing))}
            >
              Change
            </Button>
          </>
        );
      }
      return (
        <VerbList
          title="In priority order"
          items={value as BrainActionDef[]}
          names={ACTION_NAMES}
          registry={ACTIONS}
          discriminant="action"
          vocab={vocab}
          onChange={onChange}
        />
      );
    default:
      return null;
  }
}

const LET_KINDS = PARAM_KINDS.filter((kind) => kind !== "slot");

const LET_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function freshValue(kind: ParamKind, scope: ArgScope, vocab: Vocabulary): unknown {
  switch (kind) {
    case "cells":
    case "steps":
    case "spell":
      return 1;
    case "ms":
      return 1000;
    case "percent":
      return 50;
    case "hour":
      return 12;
    case "level":
      return 0;
    case "boolean":
      return false;
    case "text":
      return "";
    case "bodies":
      return [PLAYER_TILE_ID];
    case "things":
      return [vocab.kinds.find((one) => one.key === "thing")?.tiles[0]?.tileId ?? PLAYER_TILE_ID];
    case "item":
    case "consumable":
      return vocab.tiles[kind][0]?.tileId ?? "";
    case "status":
      return vocab.statuses[0]?.value ?? "";
    case "selector":
      return HOME_SELECTOR;
    case "condition":
      return CONDITIONS.after.make();
    case "actions":
      return [{ action: "hold" }];
    case "band":
      return "idle";
    case "state":
      return scope.states[0] ?? REST_STATE;
    case "slot":
      return "target";
  }
}

function LetList({
  lets,
  scope,
  vocab,
  onChange,
  onRename,
}: {
  lets: Record<string, TraitLet>;
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: Record<string, TraitLet>) => void;
  onRename: (from: string, to: string) => void;
}) {
  const names = Object.keys(lets);
  const add = () => {
    let name = "when";
    for (let i = 2; Object.hasOwn(lets, name); i++) name = `when_${i}`;
    onChange({ ...lets, [name]: { kind: "condition", value: CONDITIONS.after.make() } });
  };
  const remove = (name: string) => {
    const next = { ...lets };
    delete next[name];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span
          className="text-xs font-bold uppercase text-muted"
          title="A let names a value once, for the brain's states, rows, triggers and traits to use."
        >
          Lets
        </span>
        <Button size="sm" variant="secondary" onClick={add}>
          Add let
        </Button>
      </div>
      {names.map((name, i) => (
        <LetRow
          key={name}
          name={name}
          bound={lets[name]!}
          taken={names}
          scope={{
            ...scope,
            lets: Object.fromEntries(names.slice(0, i).map((one) => [one, lets[one]!])),
          }}
          vocab={vocab}
          onRename={(to) => onRename(name, to)}
          onChange={(next) => onChange({ ...lets, [name]: next })}
          onRemove={() => remove(name)}
        />
      ))}
    </div>
  );
}

function LetRow({
  name,
  bound,
  taken,
  scope,
  vocab,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  bound: TraitLet;
  taken: string[];
  scope: ArgScope;
  vocab: Vocabulary;
  onRename: (next: string) => void;
  onChange: (next: TraitLet) => void;
  onRemove: () => void;
}) {
  const rename = (next: string) => {
    const clean = next.trim();
    if (clean === name || taken.includes(clean) || !LET_NAME.test(clean)) return;
    onRename(clean);
  };

  return (
    <div className="flex flex-col gap-1.5 bg-panel p-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          defaultValue={name}
          onBlur={(e) => rename(e.target.value)}
          className="w-32 font-bold"
          aria-label="Let name"
        />
        <Select
          value={bound.kind}
          onValueChange={(kind) =>
            kind &&
            onChange({
              kind: kind as ParamKind,
              value: freshValue(kind as ParamKind, scope, vocab),
            })
          }
          options={LET_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
          className="min-w-[9rem]"
          ariaLabel="What the let holds"
        />
        <Button
          size="sm"
          variant="danger"
          className="ml-auto"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
        >
          ✕
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-1">
        <ArgValue
          param={{ kind: bound.kind }}
          value={bound.value}
          scope={scope}
          vocab={vocab}
          onChange={(value) => onChange({ ...bound, value })}
          ariaLabel={name}
        />
      </div>
    </div>
  );
}

const STATE_BAND = "";

function TriggerList({
  triggers,
  scope,
  vocab,
  onChange,
}: {
  triggers: BrainTriggerDef[];
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: BrainTriggerDef[]) => void;
}) {
  const add = () =>
    onChange([...triggers, { if: CONDITIONS.after.make(), to: scope.states[0] ?? REST_STATE }]);
  const set = (i: number, next: BrainTriggerDef) =>
    onChange(triggers.map((t, j) => (j === i ? next : t)));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span
          className="text-xs font-bold uppercase text-muted"
          title="A trigger leaves from every state that holds at a lower band than it fires at. Higher bands are asked first."
        >
          Triggers (higher band first)
        </span>
        <Button size="sm" variant="secondary" onClick={add}>
          Add trigger
        </Button>
      </div>
      <DragDropProvider onDragEnd={(event) => onSortEnd(event, triggers, onChange)}>
        <div className="flex flex-col gap-1">
          {triggers.map((trigger, i) => (
            <TriggerRow
              key={i}
              id={String(i)}
              index={i}
              trigger={trigger}
              scope={scope}
              vocab={vocab}
              onChange={(next) => set(i, next)}
              onRemove={() => onChange(triggers.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      </DragDropProvider>
    </div>
  );
}

function TriggerRow({
  id,
  index,
  trigger,
  scope,
  vocab,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  trigger: BrainTriggerDef;
  scope: ArgScope;
  vocab: Vocabulary;
  onChange: (next: BrainTriggerDef) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });

  const setBand = (band: string | null) => {
    const { band: _drop, ...rest } = trigger;
    onChange(band ? { ...rest, band: band as Band } : rest);
  };
  const setRetarget = (on: boolean) => {
    const { retarget: _drop, ...rest } = trigger;
    onChange(on ? { ...rest, retarget: true } : rest);
  };

  return (
    <div
      ref={ref}
      className={["flex flex-col gap-1.5 bg-panel p-1.5", isDragging ? "opacity-60" : ""].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DragHandle handleRef={handleRef} label={`Drag to reorder trigger ${index + 1}`} />
        <span className="w-5 text-center font-mono text-[11px] text-muted">{index + 1}</span>
        <span className="text-[10px] uppercase text-muted">band</span>
        <Select
          value={typeof trigger.band === "string" ? trigger.band : STATE_BAND}
          onValueChange={setBand}
          options={[
            { value: STATE_BAND, label: "its state's" },
            ...BANDS.map((band) => ({ value: band, label: band })),
          ]}
          className="min-w-[6rem]"
          ariaLabel="Band this trigger fires at"
        />
        <label
          className="flex items-center gap-1 text-[10px] uppercase text-muted"
          title="Fire again while already in its state, to bind a new target."
        >
          <Switch
            checked={trigger.retarget === true}
            onCheckedChange={setRetarget}
            ariaLabel="Fire again while in its state"
          />
          re-point
        </label>
        <BindField transition={trigger} vocab={vocab} onChange={onChange} />
        <span className="text-[10px] uppercase text-muted">to</span>
        <Select
          value={trigger.to || null}
          onValueChange={(v) => v && onChange({ ...trigger, to: v })}
          options={scope.states.map((name) => ({ value: name, label: name }))}
          className="min-w-[6rem]"
          placeholder="…"
        />
        <Button size="sm" variant="danger" onClick={onRemove} aria-label="Remove trigger">
          ✕
        </Button>
      </div>
      <div className="flex items-start gap-2 pl-7">
        <span className="pt-1.5 text-[10px] uppercase text-muted">if</span>
        <ConditionTree
          root={trigger.if}
          lets={conditionLets(scope.lets)}
          vocab={vocab}
          onChange={(next) => onChange({ ...trigger, if: next })}
        />
      </div>
    </div>
  );
}

function ExpandedTable({ table, bands }: { table: BrainDef; bands: Record<string, Band> }) {
  const names = Object.keys(table.states);

  return (
    <details className="border-2 border-border bg-paper p-2">
      <summary className="cursor-pointer text-xs font-bold uppercase text-muted">
        What it runs: {names.length} states, {table.transitions.length} rows
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-[11px] leading-snug">
        <ul className="flex flex-col gap-1">
          {names.map((name) => {
            const state = table.states[name]!;
            const entered = describeEffects(state.onEnter);
            return (
              <li key={name}>
                <span className="font-bold">{name}</span>
                <span className="text-muted"> at {bands[name] ?? "idle"}</span>
                {entered ? <span className="text-muted"> · on enter </span> : null}
                {entered}
                <span className="text-muted"> · does </span>
                {describeActions(state.do)}
              </li>
            );
          })}
        </ul>
        <ol className="flex flex-col gap-1">
          {table.transitions.map((row, i) => (
            <li key={i}>
              <span className="font-mono text-muted">{i + 1}.</span> {describeFrom(row.from)} →{" "}
              <span className="font-bold">{row.to}</span>
              <span className="text-muted"> if </span>
              {describeCondition(row.if)}
              {row.bind ? (
                <>
                  <span className="text-muted"> binding </span>
                  {Object.entries(row.bind)
                    .map(([name, source]) => `$${name} to ${describeSelector(source)}`)
                    .join(", ")}
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
