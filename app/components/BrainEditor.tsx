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
  DEFAULT_THING,
  EFFECTS,
  EFFECT_NAMES,
  type ParamSpec,
  type TileFilter,
} from "../lib/brainCatalog";
import { PLAYER_TILE_ID } from "../game/constants";
import { resolveActor, type TileDef } from "../lib/types";
import { resolveBattler } from "../lib/battler";
import type { StatusDef } from "../lib/status";
import { resolveConsumable, resolveItem } from "../lib/item";
import { resolveExtract } from "../lib/interactions";
import { DragDropProvider } from "@dnd-kit/react";
import { ConditionTreeEditor } from "./ConditionTreeEditor";
import { DragHandle } from "./DragHandle";
import { EditorIssues } from "./EditorIssues";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Button, Input, NumberInput, Segmented, Select, Switch } from "../ui";

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
  /** Whole library — the tile chips are picked out of it. */
  tiles: TileDef[];
  /** The status catalogue, for the `status` condition's picker. */
  statusDefs: Record<string, StatusDef>;
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
 * Tiles worth offering as a `thing` target — the ones that do something.
 *
 * Every tile in the library would be a picker with a hundred floors and walls in
 * it, and unlike {@link bodyTileIds} there is no flag saying which are worth
 * naming: a bush is an ordinary prop that happens to carry an `extract` block.
 * So the block *is* the test. A tile with an interaction is a tile a creature
 * could do something about; a tile with none is scenery, and a brain that walked
 * to it would be walking to a patch of floor.
 *
 * Actors are left out because they are {@link bodyTileIds}' answer already, and
 * offering a wolf under both readings would be two ways to say one thing with
 * different results.
 *
 * Sorted, so the picker does not reshuffle when the library is reordered.
 */
export function thingTileIds(tiles: TileDef[]): string[] {
  return tiles
    .filter((tile) => !resolveActor(tile) && hasAnyInteraction(tile))
    .map((tile) => tile.id)
    .sort();
}

/** Does this tile carry an interaction block with anything in it? */
function hasAnyInteraction(tile: TileDef): boolean {
  return Object.keys(tile.interactions ?? {}).length > 0;
}

/**
 * What a *brain* can do to this tile, in the words the row uses.
 *
 * The inference the whole `thing` selector exists for, and it is deliberately
 * read off the tile rather than written down beside it: author an `extract`
 * block onto a rock and the brain editor says the rock can be picked, in the
 * same edit and with nothing else to remember.
 *
 * **The brain's verbs and not the player's.** A tile is pushable, or edible off
 * the floor, or a dozen other things a person can do to it — and a line here
 * naming one of those would be telling an author about a verb this table cannot
 * offer them. So the list is exactly the two actions that take a {@link Selector}
 * and can refuse it: `attack`, which wants a body, and `extract`, which wants a
 * thing. Eating is not among them because `consume` names a tile in the bag
 * rather than a selector — its own picker is where that inference lands.
 *
 * Empty for a tile a brain can only walk to, which is most of them — and an
 * empty list is the useful answer, because it is what tells an author that the
 * `extract` they just pointed at the player will never do anything.
 */
export function affordancesOf(tileId: string, tiles: TileDef[]): string[] {
  const tile = tiles.find((one) => one.id === tileId);
  if (!tile) return [];

  const verbs: string[] = [];
  // The author's own word for the pull — "pick" on a bush, "mine" on a vein —
  // because a row that said "extract" would be the schema's word rather than
  // the one already on the button a player presses.
  const extract = resolveExtract(tile);
  if (extract?.actionName) verbs.push(extract.actionName.toLowerCase());
  // A body is the only thing with hit points to take, and `resolveActor` is the
  // same test the `nearest` picker is built from — so what this says about a
  // wolf and what that offers as a wolf cannot come apart.
  if (resolveActor(tile) || resolveBattler(tile)) verbs.push("attack");
  return verbs;
}

/**
 * One kind a selector may be: `nearest`, `thing`, `speaker`, or a slot the brain
 * binds.
 *
 * The picker used to offer one row per *tile* — "nearest Player", "nearest Rat",
 * "the Bush" — which worked while a selector named one tile and stopped working
 * the moment it could name several. There is no dropdown row for "deer and
 * rabbit but not wolf". So the kind and the tiles are two controls: this picks
 * the question, and {@link TileChips} picks what it is about.
 */
export type SelectorKind = {
  /** Stable id for the `<select>`, and how a selector is matched to its kind. */
  key: string;
  label: string;
  /** A fresh selector of this kind. */
  make: () => Selector;
  /** Tiles this kind may name. Empty for the kinds that name none. */
  tiles: TileOption[];
};

/** What a selector names and what a brain can do to it. @see affordancesOf */
export type SelectorNames = { tiles: string[]; affords: string[] };

/** One tile a picker may offer. */
export type TileOption = { tileId: string; label: string };

/**
 * Everything this editor may offer, worked out once from the brain and the
 * library.
 *
 * One value rather than four props, because they are all answers to the same
 * question — what is authorable here — and they are all needed at the same
 * depth: a selector picker, its tile chips and a `tile` field sit side by side
 * on one action row, five components down from the only place that has seen the
 * library.
 *
 * {@link describe} is a closure rather than data because a slot's answer depends
 * on the brain: `$bush` affords picking only because of the transition that
 * binds it, and a control deep in a state's action list has no way to know that.
 */
export type Vocabulary = {
  kinds: SelectorKind[];
  /** The tiles each kind of `tile` field will offer. @see TileFilter */
  tiles: Record<TileFilter, TileOption[]>;
  /** The whole status catalogue, for a `status` field. */
  statuses: Array<{ value: string; label: string }>;
  describe(selector: Selector): SelectorNames | null;
};

/** Which kind a selector is, as the key its row in the picker carries. */
export function selectorKindKey(selector: Selector): string {
  return selector.type === "slot" ? `$${selector.data.name}` : selector.type;
}

/**
 * The tiles behind each {@link TileFilter}, which is where those names turn into
 * a filter over the library.
 *
 * `item` is anything that can be in a bag and `consumable` is the half of that
 * which can be eaten, so the two nest — which is right, because `carrying berry`
 * and `consume berry` are the same berry asked about twice.
 */
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

/**
 * The kinds a selector may be, and what each may name.
 *
 * `speaker` and `attacker` are offered everywhere rather than only on the
 * transitions that hear or are hit, because the editor would have to know which
 * condition a bind sits beside to say otherwise — and a selector that answers
 * nobody is already the documented behaviour, not a broken brain. `home` is
 * offered on the same terms and is the odd one out: it names a place, so the
 * verbs wanting a body answer nobody with it.
 *
 * Every slot the brain's transitions bind is offered too, which is what makes
 * `$prey` authorable in the state the transition leads to.
 */
export function selectorVocabulary(
  brain: BrainDef,
  tiles: TileDef[],
  statusDefs: Record<string, StatusDef> = {},
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
      // The player rather than any other tile, because every verb this is a
      // default for — notice, chase, swing — is overwhelmingly authored about
      // the person.
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
      selector.type === "slot"
        ? slotTiles(brain, selector.data.name)
        : tilesNamedBy(selector);
    if (tileIds.length === 0) return null;
    return {
      tiles: tileIds.map(nameOf),
      // The union, because a wolf offered "deer or rabbit" can do to either
      // whatever it can do to both — and a verb that only one of them affords
      // is exactly the mismatch worth showing.
      affords: [
        ...new Set(tileIds.flatMap((tileId) => affordancesOf(tileId, tiles))),
      ],
    };
  };

  return {
    kinds,
    tiles: tileOptions(tiles),
    statuses: Object.values(statusDefs).map((def) => ({
      value: def.id,
      label: def.name,
    })),
    describe,
  };
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

export function BrainEditor({ brain, tiles, statusDefs, onChange }: Props) {
  if (!brain) {
    return (
      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <p className="text-[11px] leading-snug text-muted">
          None. A brain is a state machine that drives the body when nobody is
          connected to it, and makes the tile an Actor.
        </p>
        <Button size="sm" className="w-fit" onClick={() => onChange(EMPTY_BRAIN)}>
          Add brain
        </Button>
      </div>
    );
  }

  const stateNames = Object.keys(brain.states);
  const vocab = selectorVocabulary(brain, tiles, statusDefs);
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
      <BindField transition={transition} vocab={vocab} onChange={onChange} />
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
          vocab={vocab}
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

/** The condition picker and whatever parameters that condition takes. */
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
        vocab={vocab}
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
  vocab,
  onChange,
  className,
}: {
  value: Selector;
  vocab: Vocabulary;
  onChange: (next: Selector) => void;
  className?: string;
}) {
  const key = selectorKindKey(value);
  const kind = vocab.kinds.find((one) => one.key === key);
  // A kind the brain carries but the library no longer offers — a slot whose
  // last bind was deleted — still shows, marked, rather than silently reading as
  // whatever happens to sit first in the list.
  const rows = kind
    ? vocab.kinds
    : [{ key, label: `${key} (missing)`, make: () => value, tiles: [] }, ...vocab.kinds];

  return (
    <>
      <Select
        value={key}
        onValueChange={(next) => {
          const picked = rows.find((one) => one.key === next);
          if (picked) onChange(picked.make());
        }}
        options={rows.map((one) => ({ value: one.key, label: one.label }))}
        className={className}
      />
      {kind && kind.tiles.length > 0 ? (
        <TileChips
          picked={tilesNamedBy(value)}
          options={kind.tiles}
          onChange={(tileIds) =>
            onChange({ ...value, data: { tileIds } } as Selector)
          }
        />
      ) : null}
      <Affordances names={vocab.describe(value)} />
    </>
  );
}

/**
 * The tiles a selector names, as removable chips plus a dropdown that adds one.
 *
 * **Chips rather than the library's `TileIdMultiSelect`**, which is a searchable
 * panel with previews and is right where it is used — a whole field on a tile's
 * own form. This sits inline in an action row beside three other controls, and a
 * panel there would push the row that *is* the semantics off the screen.
 *
 * The last chip will not come off. A selector naming no tiles is one the schema
 * refuses, so removing it would make the brain inert for what looks like an
 * ordinary click; changing your mind about the only tile is picking the new one
 * and then dropping the old.
 */
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

/**
 * What the selected thing is and what can be done to it — `Bush · pick`.
 *
 * Read from the tile rather than from the verb beside it, and it deliberately
 * neither filters the verb picker nor refuses a save. An author mid-way through
 * re-pointing a row has a line that momentarily makes no sense, and a UI that
 * argued with them about it would be arguing on every keystroke. What this does
 * is answer the question the row cannot: `$bush` is a slot name somebody
 * invented, and this is where the editor says what is actually in it.
 *
 * Nothing at all for a selector naming no tile, rather than a line saying so:
 * `speaker` affords whatever the speaker turns out to be, and an empty label
 * beside it would read as an assertion.
 */
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
          vocab={vocab}
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
  vocab,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  vocab: Vocabulary;
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
      // An optional box says what leaving it empty means, since that is a value
      // rather than a field somebody has not filled in yet.
      placeholder={spec.optional ? "any" : spec.label}
      aria-label={spec.label}
    />
  );
}

/**
 * Whether a `consume` eats off the board, and what.
 *
 * **"Out of the bag" is a value in this picker and the absence of the field**,
 * on {@link SpeakerFilterField}'s terms and for its reason: a `consume` with no
 * selector eats what it is carrying, and a selector sitting there beside a
 * switch reading "bag" would look as though it meant something.
 */
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
      {value ? (
        <SelectorPicker value={value} vocab={vocab} onChange={onChange} />
      ) : null}
    </label>
  );
}

/**
 * A tile from the library, as a dropdown.
 *
 * **"Anything" is a value in this picker and the absence of the field in the
 * authored line**, which is the same collapse {@link SpeakerFilterField} makes
 * of "anybody" and is here for the same reason: a `carrying` with no tile asks
 * about anything at all, and an empty box that could also mean an unset field
 * would be two states drawn as one.
 *
 * A tile the brain names but the library no longer offers still shows, marked,
 * on {@link SelectorPicker}'s terms — a renamed tile is a line worth seeing
 * rather than one that silently reads as whatever sits first in the list.
 */
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

