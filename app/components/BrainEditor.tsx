import {
  ANY_STATE,
  ATTACKER_SELECTOR,
  HOME_SELECTOR,
  SPEAKER_SELECTOR,
  isSelector,
  isSpeakerFilter,
  nearest,
  selectorKey,
  slot,
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
  appendTo,
  group,
  isConditionGroup,
  removeAt,
  replaceAt,
  type Combinator,
  type ConditionGroup,
  type ConditionPath,
} from "../lib/conditions";
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
import { ConditionTreeEditor } from "./ConditionTreeEditor";
import { DragHandle } from "./DragHandle";
import { EditorIssues } from "./EditorIssues";
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
 * Tiles worth offering as a `nearest` target — the ones a body can actually be.
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
 * One offerable selector: the value itself, a stable id for the `<select>`, and
 * what to call it on screen.
 *
 * The key exists because a dropdown trades in strings and a selector is an
 * object — it is how a chosen option is matched back to the thing it stands for,
 * and nothing else reads it.
 */
export type SelectorOption = {
  key: string;
  label: string;
  selector: Selector;
};

/**
 * The live queries, plus every slot the brain's transitions bind.
 *
 * One `nearest` per tile something can be standing on, which is what turns the
 * picker into the whole vocabulary of relationships: the player to hunt, the
 * creature's own tile to flock with, some third one to follow. The editor cannot
 * know which a brain means, so it offers all of them.
 *
 * `speaker` and `attacker` are offered everywhere rather than only on the
 * transitions that hear or are hit, because the editor would have to know which
 * condition a bind sits beside to say otherwise — and a selector that answers
 * nobody is already the documented behaviour, not a broken brain.
 *
 * `home` is offered on the same terms and is the odd one out of the set: it
 * names a place, so the verbs wanting a body answer nobody with it. Listing it
 * beside the rest rather than only under the distance verbs is the same
 * decision — the picker does not know what it sits next to, and the fallback is
 * documented rather than broken.
 */
export function selectorOptions(
  brain: BrainDef,
  tiles: TileDef[],
): SelectorOption[] {
  const named = new Map(tiles.map((tile) => [tile.id, tile.name || tile.id]));
  const options: SelectorOption[] = bodyTileIds(tiles).map((tileId) => ({
    key: `nearest:${tileId}`,
    label: `nearest ${named.get(tileId) ?? tileId}`,
    selector: nearest(tileId),
  }));

  options.push(
    { key: "speaker", label: "speaker", selector: SPEAKER_SELECTOR },
    { key: "attacker", label: "attacker", selector: ATTACKER_SELECTOR },
    { key: "home", label: "home", selector: HOME_SELECTOR },
  );

  const slots = new Set<string>();
  for (const t of brain.transitions) {
    for (const name of Object.keys(t.bind ?? {})) slots.add(name);
  }
  for (const name of slots) {
    options.push({ key: `$${name}`, label: `$${name}`, selector: slot(name) });
  }

  return options;
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
  selectors: SelectorOption[];
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
  selectors: SelectorOption[];
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
  selectors: SelectorOption[];
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
  selectors: SelectorOption[];
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
  selectors: SelectorOption[];
  onChange: (next: BrainTransitionDef) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });
  const fromOptions = [ANY_STATE, ...stateNames].map((n) => ({ value: n, label: n }));
  const toOptions = stateNames.map((n) => ({ value: n, label: n }));

  return (
    <div
      ref={ref}
      className={[
        "flex flex-col gap-1.5 bg-panel p-1.5",
        isDragging ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
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
      <BindField transition={transition} selectors={selectors} onChange={onChange} />
      <span className="text-[10px] uppercase text-muted">to</span>
      <Select
        value={transition.to || null}
        onValueChange={(v) => v && onChange({ ...transition, to: v })}
        options={toOptions}
        className="min-w-[6rem]"
        placeholder="…"
      />
        <Button
          size="sm"
          variant="danger"
          onClick={onRemove}
          aria-label="Remove transition"
        >
          ✕
        </Button>
      </div>
      <div className="flex items-start gap-2 pl-7">
        <span className="pt-1.5 text-[10px] uppercase text-muted">if</span>
        <ConditionTree
          root={transition.if}
          selectors={selectors}
          onChange={(next) => onChange({ ...transition, if: next })}
        />
      </div>
    </div>
  );
}

/**
 * A transition's `if`, however deep it goes — the shared tree editor, with the
 * brain's own condition picker as its leaf. @see ./ConditionTreeEditor
 */
function ConditionTree({
  root,
  selectors,
  onChange,
}: {
  root: BrainCondition;
  selectors: SelectorOption[];
  onChange: (next: BrainCondition) => void;
}) {
  return (
    <ConditionTreeEditor<BrainConditionDef>
      root={root}
      onChange={onChange}
      leaf={{
        render: (leaf, set) => <LeafFields leaf={leaf} selectors={selectors} onChange={set} />,
        fresh: () => CONDITIONS.after.make(),
      }}
    />
  );
}

/** The condition picker and whatever parameters that condition takes. */
function LeafFields({
  leaf,
  selectors,
  onChange,
}: {
  leaf: BrainConditionDef;
  selectors: SelectorOption[];
  onChange: (next: BrainConditionDef) => void;
}) {
  return (
    <>
      <Select
        value={leaf.cond}
        onValueChange={(v) =>
          v && onChange(CONDITIONS[v as BrainConditionDef["cond"]].make())
        }
        options={CONDITION_NAMES.map((n) => ({
          value: n,
          label: CONDITIONS[n].label,
        }))}
        className="min-w-[7rem]"
      />
      <ParamFields
        item={leaf as unknown as Record<string, unknown>}
        params={CONDITIONS[leaf.cond].params}
        selectors={selectors}
        onChange={(next) => onChange(next as unknown as BrainConditionDef)}
      />
    </>
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
  selectors: SelectorOption[];
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
          selectors={selectors}
          onChange={(next) => set(slotName, next)}
          className="min-w-[6rem]"
        />
      ) : null}
    </label>
  );
}

/**
 * A selector as a dropdown.
 *
 * The one place the object/string boundary is crossed: options are keyed for the
 * `<select>` and mapped straight back to the selector they stand for, so nothing
 * downstream ever sees the key. A value the brain carries but the library no
 * longer offers — a tile since renamed — still shows, rather than silently
 * reading as whatever happens to sit first in the list.
 */
function SelectorPicker({
  value,
  selectors,
  onChange,
  className,
}: {
  value: Selector;
  selectors: SelectorOption[];
  onChange: (next: Selector) => void;
  className?: string;
}) {
  const key = selectorKey(value);
  const known = selectors.some((option) => option.key === key);
  const options = known
    ? selectors
    : [{ key, label: `${key} (missing)`, selector: value }, ...selectors];

  return (
    <Select
      value={key}
      onValueChange={(next) => {
        const picked = options.find((option) => option.key === next);
        if (picked) onChange(picked.selector);
      }}
      options={options.map((option) => ({
        value: option.key,
        label: option.label,
      }))}
      className={className}
    />
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
  selectors: SelectorOption[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <>
      {params.map((spec) => (
        <ParamField
          key={spec.key}
          spec={spec}
          value={item[spec.key]}
          selectors={selectors}
          onChange={(value) => onChange(paramPatch(item, spec, value))}
        />
      ))}
    </>
  );
}

/**
 * One field of a condition or action, written back into it.
 *
 * **A value that means "not set" deletes the key rather than writing a falsy
 * one**, which is the whole of what this exists to get right. A false boolean is
 * authored by its absence, matching how the rest of `tiles.json` writes optional
 * flags, so it round-trips clean. So is a filter set back to "anybody": absence
 * *is* the value, not a third state beside it. An emptied optional text is the
 * same shape of thing — "any sound" is the field not being there, and writing
 * `""` would author a word of length zero that the schema refuses, turning the
 * creature inert for what looks like an empty box.
 *
 * A *required* text is deliberately not covered by that last rule: an empty one
 * there is a mistake rather than a meaning, and removing the key would hide it
 * behind a default instead of showing it as the broken condition it is.
 */
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
  selectors,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  selectors: SelectorOption[];
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
      <SelectorPicker
        value={isSelector(value) ? value : DEFAULT_SELECTOR}
        selectors={selectors}
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
        selectors={selectors}
        onChange={onChange}
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
      // An optional box says what leaving it empty means, since that is a value
      // rather than a field somebody has not filled in yet.
      placeholder={spec.optional ? "any" : spec.label}
      aria-label={spec.label}
    />
  );
}

/**
 * Whose voice a `heard` counts, as one control rather than two.
 *
 * "Anybody" is a value in this picker and the *absence* of the field in the
 * authored condition, and collapsing the two is what stops the editor writing a
 * filter with a match and no selector. The selector only appears once there is
 * somebody to be — a dropdown offering `$partner` beside a match of "anybody"
 * would read as though it meant something.
 */
function SpeakerFilterField({
  spec,
  value,
  selectors,
  onChange,
}: {
  spec: ParamSpec;
  value: SpeakerFilter | null;
  selectors: SelectorOption[];
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
          selectors={selectors}
          onChange={(of) => onChange({ ...value, of })}
          className="min-w-[7rem]"
        />
      ) : null}
    </label>
  );
}

