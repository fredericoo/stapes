import {
  ANY_STATE,
  ATTACKER_SELECTOR,
  SPEAKER_SELECTOR,
  nearest,
  validateBrain,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainDef,
  type BrainEffectDef,
  type BrainStateDef,
  type BrainTransitionDef,
  type Selector,
} from "../lib/brain";
import {
  ACTIONS,
  ACTION_NAMES,
  CONDITIONS,
  CONDITION_NAMES,
  DEFAULT_SELECTOR,
  EFFECTS,
  EFFECT_NAMES,
  type ParamSpec,
} from "../lib/brainCatalog";
import { PLAYER_TILE_ID } from "../game/constants";
import { resolveActor, type TileDef } from "../lib/types";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Button, Input, Segmented, Select, Switch } from "../ui";

/**
 * Authoring a brain as two tables rather than JSON.
 *
 * The shape is the tiles editor's own — sections and rows — because the thing
 * being authored is already a table: an ordered transition list where position
 * is priority, and a set of states each holding an ordered `do` list where
 * position is priority again. A node canvas would draw those orderings badly, so
 * the one thing this UI works to make loud is order: the number on a row, the
 * handle that drags it, the fact that the first match and the first non-failing
 * action are what run. Reorder is drag-and-drop, the same @dnd-kit sortable the
 * tile-stack list uses, so the two ordered things in the editor behave alike.
 *
 * Every picker is fed from the registry catalog, so the editor cannot name a
 * condition, action or effect the runtime does not implement — a whole class of
 * broken brain that simply cannot be authored here.
 */

type Props = {
  /** The brain, or undefined on a tile that has none yet. */
  brain: BrainDef | undefined;
  /** Whole library — the `nearest:` picker names bodies out of it. */
  tiles: TileDef[];
  onChange: (next: BrainDef | undefined) => void;
};

const EMPTY_BRAIN: BrainDef = {
  initial: "idle",
  states: { idle: { do: [{ action: "hold" }] } },
  transitions: [],
};

/**
 * Tiles worth offering as a `nearest:` target — the ones a body can actually be.
 *
 * Every tile in the library would be a picker with a hundred walls and floors in
 * it, none of which anything is ever standing on. The player is named explicitly
 * because it is a body by virtue of somebody connecting to it rather than by an
 * authored flag, so {@link resolveActor} does not see it.
 *
 * Sorted so the picker does not reshuffle when the library is reordered, with the
 * player first because it is the target nearly every brain wants.
 */
export function bodyTileIds(tiles: TileDef[]): string[] {
  const ids = tiles
    .filter((tile) => tile.id !== PLAYER_TILE_ID && resolveActor(tile))
    .map((tile) => tile.id)
    .sort();
  return [PLAYER_TILE_ID, ...ids];
}

/**
 * The live queries, plus every slot the brain's transitions bind.
 *
 * One `nearest:` per tile something can be standing on, which is what turns the
 * picker into the whole vocabulary of relationships: the player to hunt, the
 * creature's own tile to flock with, some third one to follow. The editor cannot
 * know which a brain means, so it offers all of them.
 *
 * `speaker` and `attacker` are offered everywhere rather than only on the
 * transitions that hear or are hit, because the editor would have to know which
 * condition a bind sits beside to say otherwise — and a selector that answers
 * nobody is already the documented behaviour, not a broken brain.
 */
export function selectorOptions(brain: BrainDef, tiles: TileDef[]): string[] {
  const slots = new Set<string>();
  for (const t of brain.transitions) {
    for (const slot of Object.keys(t.bind ?? {})) slots.add(`$${slot}`);
  }
  return [
    ...bodyTileIds(tiles).map(nearest),
    SPEAKER_SELECTOR,
    ATTACKER_SELECTOR,
    ...slots,
  ];
}

/** Pull the item at `from` out and drop it back in at `to`. */
export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  ) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * The reorder half of a sortable list: read a settled drag and move the item.
 *
 * The same shape the tile-stack list uses — a cancelled or in-place drag is a
 * no-op, and only a real move rewrites the array, which for these lists *is* the
 * semantics being edited.
 */
function onSortEnd<T>(
  event: Parameters<
    NonNullable<React.ComponentProps<typeof DragDropProvider>["onDragEnd"]>
  >[0],
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

/** Rebuild the states record with `oldName` re-keyed to `newName`, order kept. */
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

export function BrainEditor({ brain, tiles, onChange }: Props) {
  if (!brain) {
    return (
      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <p className="text-[11px] leading-snug text-muted">
          A brain drives this body when nobody is connected to it. It is a flat
          state machine: states each run an ordered list of actions, and an
          ordered list of transitions moves between them — first match wins.
        </p>
        <Button size="sm" className="w-fit" onClick={() => onChange(EMPTY_BRAIN)}>
          Add a brain
        </Button>
      </div>
    );
  }

  const stateNames = Object.keys(brain.states);
  const selectors = selectorOptions(brain, tiles);
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
      <BrainIssues issues={issues} />

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
            selectors={selectors}
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
        selectors={selectors}
        onChange={(transitions) => onChange({ ...brain, transitions })}
      />

      <Button
        size="sm"
        variant="danger"
        className="w-fit"
        onClick={() => onChange(undefined)}
      >
        Remove brain
      </Button>
    </div>
  );
}

function BrainIssues({ issues }: { issues: ReturnType<typeof validateBrain> }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, i) => (
        <li
          key={i}
          className={[
            "border-2 px-2 py-1 text-xs",
            issue.severity === "error"
              ? "border-danger bg-danger/10 text-danger"
              : "border-accent bg-accent/10 text-ink",
          ].join(" ")}
        >
          {issue.severity === "error" ? "✕ " : "! "}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function StateCard({
  name,
  state,
  selectors,
  taken,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  state: BrainStateDef;
  selectors: string[];
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

      <EmitField
        emit={state.emit}
        onChange={(emit) => onChange({ ...state, emit })}
      />

      <VerbList
        title="On enter (effects)"
        items={state.onEnter ?? []}
        names={EFFECT_NAMES}
        registry={EFFECTS}
        discriminant="effect"
        selectors={selectors}
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
        selectors={selectors}
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
          onCheckedChange={(on) =>
            onChange(on ? { channel: "alarm", value: "on" } : undefined)
          }
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

/**
 * The shared editor for an ordered list of named verbs — a state's actions or
 * its effects. Both are "pick a name, fill its parameters, and mind the order",
 * so both are this.
 */
function VerbList<T extends BrainActionDef | BrainEffectDef>({
  title,
  items,
  names,
  registry,
  discriminant,
  selectors,
  onChange,
}: {
  title: string;
  items: T[];
  names: string[];
  registry: Record<string, { label: string; hint: string; params: ParamSpec[]; make: () => T }>;
  discriminant: "action" | "effect";
  selectors: string[];
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
              selectors={selectors}
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
  selectors,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  value: T;
  names: string[];
  registry: Record<string, { label: string; hint: string; params: ParamSpec[]; make: () => T }>;
  discriminant: "action" | "effect";
  selectors: string[];
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
      <span className="w-5 text-center font-mono text-[11px] text-muted">
        {index + 1}
      </span>
      <Select
        value={current}
        onValueChange={(v) => v && onChange(registry[v]!.make())}
        options={names.map((n) => ({ value: n, label: registry[n]!.label }))}
        className="min-w-[8rem]"
      />
      <ParamFields
        item={value as Record<string, unknown>}
        params={spec.params}
        selectors={selectors}
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
  selectors,
  onChange,
}: {
  brain: BrainDef;
  stateNames: string[];
  selectors: string[];
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
          Transitions (first match wins — order is priority)
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
              selectors={selectors}
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
  selectors,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  transition: BrainTransitionDef;
  stateNames: string[];
  selectors: string[];
  onChange: (next: BrainTransitionDef) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });
  const cond = transition.if;
  const spec = CONDITIONS[cond.cond];
  const fromOptions = [ANY_STATE, ...stateNames].map((n) => ({ value: n, label: n }));
  const toOptions = stateNames.map((n) => ({ value: n, label: n }));

  const setCond = (next: BrainConditionDef) => onChange({ ...transition, if: next });

  return (
    <div
      ref={ref}
      className={[
        "flex flex-wrap items-center gap-2 bg-panel p-1.5",
        isDragging ? "opacity-60" : "",
      ].join(" ")}
    >
      <DragHandle
        handleRef={handleRef}
        label={`Drag to reorder transition ${index + 1}`}
      />
      <span className="w-5 text-center font-mono text-[11px] text-muted">
        {index + 1}
      </span>
      <span className="text-[10px] uppercase text-muted">from</span>
      <Select
        value={transition.from}
        onValueChange={(v) => v && onChange({ ...transition, from: v })}
        options={fromOptions}
        className="min-w-[6rem]"
      />
      <span className="text-[10px] uppercase text-muted">if</span>
      <Select
        value={cond.cond}
        onValueChange={(v) => v && setCond(CONDITIONS[v as BrainConditionDef["cond"]].make())}
        options={CONDITION_NAMES.map((n) => ({ value: n, label: CONDITIONS[n].label }))}
        className="min-w-[7rem]"
      />
      <ParamFields
        item={cond as unknown as Record<string, unknown>}
        params={spec.params}
        selectors={selectors}
        onChange={(next) => setCond(next as unknown as BrainConditionDef)}
      />
      <BindField transition={transition} selectors={selectors} onChange={onChange} />
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
  );
}

/**
 * The one slot a transition binds, as a checkbox with a name.
 *
 * Kept to a single slot in the UI though the shape allows several: a transition
 * that writes down who set the creature off has exactly one quarry, and every
 * creature authored so far binds one thing. The name is what a state then reads
 * back as `$name`.
 */
function BindField({
  transition,
  selectors,
  onChange,
}: {
  transition: BrainTransitionDef;
  selectors: string[];
  onChange: (next: BrainTransitionDef) => void;
}) {
  const entry = Object.entries(transition.bind ?? {})[0];
  const slot = entry?.[0] ?? "";
  const source = entry?.[1] ?? DEFAULT_SELECTOR;

  const set = (nextSlot: string, nextSource: string) => {
    const clean = nextSlot.trim();
    const { bind: _drop, ...rest } = transition;
    if (!clean) {
      onChange(rest);
      return;
    }
    onChange({ ...rest, bind: { [clean]: nextSource as Selector } });
  };

  return (
    <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
      bind
      <Input
        value={slot}
        onChange={(e) => set(e.target.value, source)}
        className="w-20"
        placeholder="(none)"
        aria-label="Bind slot name"
      />
      {slot ? (
        <Select
          value={source}
          onValueChange={(v) => v && set(slot, v)}
          options={selectors.map((s) => ({ value: s, label: s }))}
          className="min-w-[6rem]"
        />
      ) : null}
    </label>
  );
}

function ParamFields({
  item,
  params,
  selectors,
  onChange,
}: {
  item: Record<string, unknown>;
  params: ParamSpec[];
  selectors: string[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  const write = (spec: ParamSpec, value: unknown) => {
    const next = { ...item };
    // A false boolean is authored by its absence, matching how the rest of
    // `tiles.json` writes optional flags — so it round-trips clean.
    if (spec.kind === "boolean" && value === false) delete next[spec.key];
    else next[spec.key] = value;
    onChange(next);
  };

  return (
    <>
      {params.map((spec) => (
        <ParamField
          key={spec.key}
          spec={spec}
          value={item[spec.key]}
          selectors={selectors}
          onChange={(value) => write(spec, value)}
        />
      ))}
    </>
  );
}

function ParamField({
  spec,
  value,
  selectors,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  selectors: string[];
  onChange: (value: unknown) => void;
}) {
  if (spec.kind === "boolean") {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        <Switch
          checked={Boolean(value)}
          onCheckedChange={onChange}
          ariaLabel={spec.label}
        />
        {spec.label}
      </label>
    );
  }
  if (spec.kind === "selector") {
    return (
      <Select
        value={typeof value === "string" ? value : DEFAULT_SELECTOR}
        onValueChange={(v) => v && onChange(v)}
        options={selectors.map((s) => ({ value: s, label: s }))}
        className="min-w-[7rem]"
      />
    );
  }
  if (spec.kind === "number") {
    return (
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
        {spec.label}
        <Input
          type="number"
          min={spec.min}
          value={typeof value === "number" ? value : 0}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
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
      placeholder={spec.label}
      aria-label={spec.label}
    />
  );
}

/**
 * The grip that drags a row. A dedicated handle rather than the whole row, so a
 * click on a dropdown or a number field stays a click — the same choice the
 * tile-stack list makes.
 */
function DragHandle({
  handleRef,
  label,
}: {
  handleRef: ReturnType<typeof useSortable>["handleRef"];
  label: string;
}) {
  return (
    <button
      type="button"
      ref={handleRef}
      aria-label={label}
      className="cursor-grab px-1 text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:cursor-grabbing"
    >
      <span aria-hidden="true">⋮⋮</span>
    </button>
  );
}
