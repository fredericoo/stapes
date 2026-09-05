import type {
  ActivationTrigger,
  AddStatusInteraction,
  ClimbAbility,
  DecayInteraction,
  EmitInteraction,
  ExtractInteraction,
  ExtractSlot,
  PlateComparison,
  PressurePlateInteraction,
  PushInteraction,
  ReceiveInteraction,
  RewardInteraction,
  SignalMode,
  SignalValue,
  SwitchInteraction,
  TeleportDestinationKind,
  TeleportInteraction,
  TileInteractions,
  Transmutation,
  TransmuteInteraction,
} from "../lib/interactions";
import {
  DEFAULT_ADD_STATUS,
  DEFAULT_DECAY,
  DEFAULT_EMIT,
  DEFAULT_EXTRACT,
  DEFAULT_EXTRACT_VERB,
  DEFAULT_PRESSURE_PLATE,
  DEFAULT_PUSH,
  DEFAULT_RECEIVE,
  DEFAULT_REWARD,
  DEFAULT_SWITCH,
  DEFAULT_TELEPORT,
  DEFAULT_TRANSMUTATION,
  DEFAULT_TRANSMUTE,
  DEFAULT_TRANSMUTE_VERB,
  MAX_EXTRACT_CHANCE,
  MAX_EXTRACT_SLOTS,
  MAX_TRANSMUTATION_OUTPUTS,
  MAX_TRANSMUTATIONS,
  MIN_EXTRACT_CHANCE,
  hasAnyInteraction,
} from "../lib/interactions";
import { DEFAULT_BATTLER } from "../lib/battler";
import { DEFAULT_WEAPON, resolveContainer, resolveItem } from "../lib/item";
import type { StatusDef } from "../lib/status";
import type { TileDef, TileKind, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import {
  Button,
  FieldLabel,
  Input,
  NumberInput,
  SectionTitle,
  Segmented,
  Select,
  Switch,
} from "../ui";
import { TileIdMultiSelect } from "./TileIdMultiSelect";

/** Symbols read left-to-right after the "load is" label. */
const COMPARISON_OPTIONS: Array<{ value: PlateComparison; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
];

const TRIGGER_OPTIONS: Array<{ value: ActivationTrigger; label: string }> = [
  { value: "step", label: "Step on" },
  { value: "interact", label: "Press beside" },
  { value: "interactOver", label: "Press on" },
];

/**
 * The three triggers in one tooltip, because both the sections that offer
 * them read the same three lines — what changes between them is what happens
 * afterwards, not how you set it off.
 */
const TRIGGER_INFO =
  "Step on: fires on entering the cell, with no row to press. Press beside: from an adjacent cell, the reach a switch has. Press on: while standing on it, like a ladder.";

const DESTINATION_OPTIONS: Array<{
  value: TeleportDestinationKind;
  label: string;
}> = [
  { value: "relative", label: "Relative" },
  { value: "absolute", label: "Absolute" },
];

const DELTA_AXES = ["x", "y", "z"] as const;

/** One floor up: the ladder this was built for. */
const DEFAULT_TELEPORT_DELTA = { x: 0, y: 0, z: 1 };

/** Deepest a plate can be buried: a stack may overflow one level into the next. */
const MAX_PLATE_HEIGHT = HEIGHT_PER_LEVEL * 2;

const MS_PER_SECOND = 1000;

/**
 * Authored in seconds and stored in milliseconds. A lifetime keeps a world
 * ticking for its whole length (see `GameSession.isAtRest`), so the unit the
 * author types in is the one that makes that cost obvious — "30" reads as a
 * spell of blood on the floor where "30000" reads as a number.
 */
const MAX_DECAY_SECONDS = 3600;

/**
 * Deepest a resource may be authored, in uses.
 *
 * A sanity bound rather than a balance one, on `MAX_DECAY_SECONDS`' terms: wide
 * enough for anything worth authoring, narrow enough that a typo'd extra digit
 * reads as malformed rather than as a bush nobody can ever finish.
 */
const MAX_DURABILITY = 99;

/**
 * Longest a resource may make one player wait, in seconds.
 *
 * The same number the decay field takes, because it is the same kind of
 * question and an author should not have to learn two ceilings.
 */
const MAX_COOLDOWN_SECONDS = MAX_DECAY_SECONDS;

const KIND_OPTIONS: Array<{ value: TileKind; label: string }> = [
  { value: "prop", label: "Prop" },
  { value: "battler", label: "Battler" },
  { value: "item", label: "Item" },
];

/**
 * What a reward may hand over — the same rule `rewardFits` enforces in play,
 * asked here so the picker cannot offer a tile that would make the whole reward
 * untakeable. A container is excluded because nothing nests, so it could only go
 * on a back that is already occupied by the bag the items need.
 */
function isGiveable(tile: TileDef): boolean {
  return resolveItem(tile) != null && resolveContainer(tile) == null;
}

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /**
   * The status catalogue, so the picker can offer conditions by name rather than
   * asking an author to type an id. Passed in for the reason the tile list is:
   * this tab knows what a tile may reference and nothing about where either
   * catalogue is loaded from.
   */
  statusDefs: Record<string, StatusDef>;
};

/** A section's on/off row: the switch, then the title with its tooltip. */
function SectionSwitch({
  on,
  onToggle,
  label,
  info,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  label: string;
  info: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <Switch checked={on} onCheckedChange={onToggle} ariaLabel={label} />
      <SectionTitle info={info}>{label}</SectionTitle>
    </label>
  );
}

/** The verb a row shows for this interaction, with what blank falls back to. */
function ActionLabelField({
  value,
  fallback,
  onChange,
}: {
  value: string | undefined;
  fallback: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <FieldLabel
        info={`The verb on the player's row — “Open” on a door, “Cook” at a fire. Blank reads as “${fallback}”.`}
      >
        Action label
      </FieldLabel>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallback}
        className="w-48"
      />
    </label>
  );
}

/**
 * Ways the player can interact with this tile in play mode. One section per
 * interaction kind.
 */
export function InteractiveTab({
  draft,
  onChange,
  tiles,
  tilesets,
  statusDefs,
}: Props) {
  const push = draft.interactions?.push;
  const sw = draft.interactions?.switch;
  const reward = draft.interactions?.reward;
  const transmute = draft.interactions?.transmute;
  const extract = draft.interactions?.extract;
  const teleport = draft.interactions?.teleport;
  const addStatus = draft.interactions?.addStatus;
  const decay = draft.interactions?.decay;
  const plate = draft.interactions?.pressurePlate;
  const emit = draft.interactions?.emit;
  const receive = draft.interactions?.receive;

  const setInteractions = (next: TileInteractions | undefined) => {
    onChange({ ...draft, interactions: next });
  };

  /**
   * Move the tile between kinds, seeding the block it is arriving at and
   * clearing the one it is leaving.
   *
   * Clearing is what keeps the stored kind and the blocks from telling different
   * stories. Both resolvers already refuse a block that does not match the kind,
   * so a leftover would be inert — but it would also be invisible, sitting in
   * `data/tiles.json` waiting for somebody to flip the select back and find
   * stats they never authored.
   *
   * Seeding is the other half of the Battler switch going away: the tab is now
   * shown *because* the tile is a battler, so it must never open onto nothing.
   */
  const setKind = (kind: TileKind) => {
    const merged: TileInteractions = { ...draft.interactions };
    delete merged.battler;
    delete merged.item;
    if (kind === "battler") merged.battler = { ...DEFAULT_BATTLER };
    if (kind === "item") merged.item = { ...DEFAULT_WEAPON };
    onChange({
      ...draft,
      kind,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  /** Patch one kind without clobbering the others. `null` clears that kind. */
  const patchKind = <K extends keyof TileInteractions>(
    key: K,
    value: TileInteractions[K] | null,
  ) => {
    const merged: TileInteractions = { ...draft.interactions };
    if (value == null) delete merged[key];
    else merged[key] = value;
    setInteractions(hasAnyInteraction(merged) ? merged : undefined);
  };

  const setPush = (next: PushInteraction | undefined) => {
    patchKind("push", next ?? null);
  };

  const patchPush = (patch: Partial<PushInteraction>) => {
    if (!push) return;
    setPush({ ...push, ...patch });
  };

  const setSwitch = (next: SwitchInteraction | undefined) => {
    patchKind("switch", next ?? null);
  };

  const patchSwitch = (patch: Partial<SwitchInteraction>) => {
    if (!sw) return;
    setSwitch({ ...sw, ...patch });
  };

  const setReward = (next: RewardInteraction | undefined) => {
    patchKind("reward", next ?? null);
  };

  const patchReward = (patch: Partial<RewardInteraction>) => {
    if (!reward) return;
    setReward({ ...reward, ...patch });
  };

  const setTransmute = (next: TransmuteInteraction | undefined) => {
    patchKind("transmute", next ?? null);
  };

  /**
   * Rewrite one recipe, leaving its siblings alone.
   *
   * By position rather than by identity because a recipe has none — it *is* its
   * position, which is how the row the player presses names it. See
   * `Transmutation`.
   */
  const patchRecipe = (index: number, patch: Partial<Transmutation>) => {
    if (!transmute) return;
    setTransmute({
      recipes: transmute.recipes.map((recipe, i) =>
        i === index ? { ...recipe, ...patch } : recipe,
      ),
    });
  };

  const addRecipe = () => {
    if (!transmute || transmute.recipes.length >= MAX_TRANSMUTATIONS) return;
    setTransmute({
      recipes: [...transmute.recipes, { ...DEFAULT_TRANSMUTATION }],
    });
  };

  /**
   * Drop a recipe, and the whole block with the last one.
   *
   * A transmuter with no recipes is not a transmuter — the resolver reads an
   * emptied block as "does not transmute" — so leaving one behind would be an
   * editor showing a switch that is on and a tile that does nothing.
   */
  const removeRecipe = (index: number) => {
    if (!transmute) return;
    const recipes = transmute.recipes.filter((_, i) => i !== index);
    setTransmute(recipes.length > 0 ? { recipes } : undefined);
  };

  const setExtract = (next: ExtractInteraction | undefined) => {
    patchKind("extract", next ?? null);
  };

  const patchExtract = (patch: Partial<ExtractInteraction>) => {
    if (!extract) return;
    setExtract({ ...extract, ...patch });
  };

  /**
   * Rewrite one yield slot, leaving its siblings alone.
   *
   * By position rather than by identity, on `patchRecipe`'s terms: a slot has
   * none, and two rows offering the same berry are a perfectly ordinary way to
   * author "one to three of them".
   */
  const patchSlot = (index: number, patch: Partial<ExtractSlot>) => {
    if (!extract) return;
    patchExtract({
      slots: extract.slots.map((slot, i) =>
        i === index ? { ...slot, ...patch } : slot,
      ),
    });
  };

  const addSlot = () => {
    if (!extract || extract.slots.length >= MAX_EXTRACT_SLOTS) return;
    patchExtract({
      slots: [...extract.slots, { tileId: "", chance: MAX_EXTRACT_CHANCE }],
    });
  };

  /**
   * Drop a slot, and the whole block with the last one.
   *
   * A resource with nothing to give is not a resource — the resolver reads an
   * emptied block as "cannot be worked" — so leaving one behind would be an
   * editor showing a switch that is on and a tile that does nothing.
   */
  const removeSlot = (index: number) => {
    if (!extract) return;
    const slots = extract.slots.filter((_, i) => i !== index);
    setExtract(slots.length > 0 ? { ...extract, slots } : undefined);
  };

  const setAddStatus = (next: AddStatusInteraction | undefined) => {
    patchKind("addStatus", next ?? null);
  };

  const patchAddStatus = (patch: Partial<AddStatusInteraction>) => {
    if (!addStatus) return;
    setAddStatus({ ...addStatus, ...patch });
  };

  const statusOptions = Object.values(statusDefs).map((def) => ({
    value: def.id,
    label: def.name,
  }));

  const setTeleport = (next: TeleportInteraction | undefined) => {
    patchKind("teleport", next ?? null);
  };

  const patchTeleport = (patch: Partial<TeleportInteraction>) => {
    if (!teleport) return;
    setTeleport({ ...teleport, ...patch });
  };

  /**
   * Move between the two arms, seeding the one being arrived at.
   *
   * The offset is seeded rather than carried across, because the arms hold
   * different things: an absolute teleport has no delta at all, so coming back
   * to `relative` has to land on something an author can see and edit rather
   * than on whatever was there before it was dropped.
   */
  const setDestinationKind = (kind: TeleportDestinationKind) => {
    if (!teleport || teleport.destination.kind === kind) return;
    patchTeleport({
      destination:
        kind === "relative"
          ? { kind, delta: { ...DEFAULT_TELEPORT_DELTA } }
          : { kind },
    });
  };

  const delta =
    teleport?.destination.kind === "relative"
      ? teleport.destination.delta
      : DEFAULT_TELEPORT_DELTA;

  const patchDelta = (axis: (typeof DELTA_AXES)[number], value: number) => {
    if (teleport?.destination.kind !== "relative") return;
    patchTeleport({
      destination: { kind: "relative", delta: { ...delta, [axis]: value } },
    });
  };

  const setDecay = (next: DecayInteraction | undefined) => {
    patchKind("decay", next ?? null);
  };

  const patchDecay = (patch: Partial<DecayInteraction>) => {
    if (!decay) return;
    setDecay({ ...decay, ...patch });
  };

  /**
   * Move one end of the lifetime range, carrying the other with it rather than
   * letting it be crossed.
   *
   * An inverted range parses as "does not decay", so a tile whose shortest
   * lifetime was dragged past its longest would go quietly inert with both
   * numbers still sitting there — the one failure the author could not see. The
   * pair is kept ordered here so nothing authored through this dialog can reach
   * that state.
   */
  const patchDecayBound = (end: "fromMs" | "toMs", seconds: number) => {
    if (!decay) return;
    const ms = Math.round(
      Math.min(MAX_DECAY_SECONDS, Math.max(1, seconds)) * MS_PER_SECOND,
    );
    setDecay(
      end === "fromMs"
        ? { ...decay, fromMs: ms, toMs: Math.max(ms, decay.toMs) }
        : { ...decay, toMs: ms, fromMs: Math.min(ms, decay.fromMs) },
    );
  };

  const setPlate = (next: PressurePlateInteraction | undefined) => {
    patchKind("pressurePlate", next ?? null);
  };

  const patchPlate = (patch: Partial<PressurePlateInteraction>) => {
    if (!plate) return;
    setPlate({ ...plate, ...patch });
  };

  const setEmit = (next: EmitInteraction | undefined) => {
    patchKind("emit", next ?? null);
  };

  const setReceive = (next: ReceiveInteraction | undefined) => {
    patchKind("receive", next ?? null);
  };

  const patchReceive = (patch: Partial<ReceiveInteraction>) => {
    if (!receive) return;
    setReceive({ ...receive, ...patch });
  };

  const others = tiles.filter((t) => t.id !== draft.id);
  const giveable = tiles.filter(isGiveable);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 border-2 border-border bg-panel p-3">
        <SectionTitle info="Exclusive. Prop is scenery and machinery. Battler has hit points and opens the Battle tab. Item can be carried and opens the Item tab. Every section below is available whichever is picked.">
          Kind
        </SectionTitle>
        <div>
          <Segmented<TileKind>
            value={draft.kind}
            onChange={setKind}
            options={KIND_OPTIONS}
            size="sm"
            ariaLabel="Tile kind"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(push)}
          onToggle={(on) => setPush(on ? { ...DEFAULT_PUSH } : undefined)}
          label="Push"
          info="Clicking it from an adjacent cell moves it one cell directly away from the player. Never diagonal, never further."
        />

        {push ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs">
              <FieldLabel info="How far up it can be shoved. Given a step up and a step down it takes the step down. Turn on Affected by gravity (Tile tab) to let it fall off ledges.">
                Climb
              </FieldLabel>
              <Segmented<ClimbAbility>
                value={push.climb}
                onChange={(climb) => patchPush({ climb })}
                options={[
                  { value: "none", label: "None" },
                  { value: "half", label: "Half" },
                  { value: "full", label: "Full" },
                ]}
                size="sm"
              />
            </div>

            <TileIdMultiSelect
              tiles={tiles}
              tilesets={tilesets}
              selectedIds={push.moveOnTileIds}
              onChange={(moveOnTileIds) => patchPush({ moveOnTileIds })}
              label="Allowed surfaces"
              info="It can only come to rest on top of one of these."
              emptyHint="Any."
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(sw)}
          onToggle={(on) => setSwitch(on ? { ...DEFAULT_SWITCH } : undefined)}
          label="Switch"
          info="Clicking it replaces it with the target tile. Put a switch on both tiles to toggle (door closed ↔ open). Refused when the target would not fit in the stack. With push as well, switch wins."
        />

        {sw ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <TileIdMultiSelect
              tiles={others}
              tilesets={tilesets}
              selectedIds={sw.targetTileId ? [sw.targetTileId] : []}
              onChange={(ids) =>
                patchSwitch({ targetTileId: ids[0] ?? "" })
              }
              label="Target tile"
              emptyHint="None."
              single
            />
            <ActionLabelField
              value={sw.actionName}
              fallback="Switch"
              onChange={(actionName) => patchSwitch({ actionName })}
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(reward)}
          onToggle={(on) => setReward(on ? { ...DEFAULT_REWARD } : undefined)}
          label="Reward"
          info="Gives items once per player: a tag written on the player blocks a second helping, and the tile itself never changes. Offered in purple. Refused when the bag has no room for all of it."
        />
        <p className="text-[11px] leading-snug text-muted">
          Items and tag are set per placement, in the map editor.
        </p>

        {reward ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <ActionLabelField
              value={reward.actionName}
              fallback="Take"
              onChange={(actionName) => patchReward({ actionName })}
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(transmute)}
          onToggle={(on) =>
            setTransmute(
              on ? { recipes: [...DEFAULT_TRANSMUTE.recipes] } : undefined,
            )
          }
          label="Transmute"
          info="Spends one carried item and mints the outputs fresh. Repeatable, and only offered while the input is carried. Outputs go where the input came from, spilling to pack then hands, never the floor — with no room the recipe is not offered."
        />

        {transmute ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            {transmute.recipes.map((recipe, index) => (
              <div
                key={index}
                className="flex flex-col gap-3 border-2 border-border bg-paper p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <FieldLabel>Recipe {index + 1}</FieldLabel>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRecipe(index)}
                  >
                    Remove
                  </Button>
                </div>

                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel
                    info={`The row reads as verb plus input — “Cook Raw Meat”. Blank reads as “${DEFAULT_TRANSMUTE_VERB}”.`}
                  >
                    Action label
                  </FieldLabel>
                  <Input
                    value={recipe.verb ?? ""}
                    onChange={(e) => patchRecipe(index, { verb: e.target.value })}
                    placeholder={DEFAULT_TRANSMUTE_VERB}
                    className="w-48"
                  />
                </label>

                <TileIdMultiSelect
                  tiles={giveable}
                  tilesets={tilesets}
                  selectedIds={recipe.fromTileId ? [recipe.fromTileId] : []}
                  onChange={(ids) =>
                    patchRecipe(index, { fromTileId: ids[0] ?? "" })
                  }
                  label="Input"
                  info="Looked for in the player's hands first, then the bag."
                  emptyHint="None."
                  single
                />

                <TileIdMultiSelect
                  tiles={giveable}
                  tilesets={tilesets}
                  selectedIds={recipe.toTileIds}
                  onChange={(toTileIds) =>
                    patchRecipe(index, {
                      toTileIds: toTileIds.slice(0, MAX_TRANSMUTATION_OUTPUTS),
                    })
                  }
                  label="Outputs"
                  info={`Up to ${MAX_TRANSMUTATION_OUTPUTS}, never a container.`}
                  emptyHint="None — the recipe is dropped on save."
                />
              </div>
            ))}

            {transmute.recipes.length < MAX_TRANSMUTATIONS ? (
              <Button variant="secondary" size="sm" onClick={addRecipe}>
                Add recipe
              </Button>
            ) : (
              <span className="text-[11px] leading-snug text-muted">
                Up to {MAX_TRANSMUTATIONS} recipes.
              </span>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(extract)}
          onToggle={(on) =>
            setExtract(
              on
                ? { ...DEFAULT_EXTRACT, slots: [...DEFAULT_EXTRACT.slots] }
                : undefined,
            )
          }
          label="Extract"
          info="Each use rolls every yield slot and hands over what came up. Uses are shared — the placement is the same vein for everybody. The cooldown is per player, per placement."
        />

        {extract ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <ActionLabelField
              value={extract.actionName}
              fallback={DEFAULT_EXTRACT_VERB}
              onChange={(actionName) => patchExtract({ actionName })}
            />

            <div className="flex flex-wrap items-start gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel info="How many times a fresh placement can be worked before it becomes the depleted tile. Shared across players. Lowering it later shortens every placement in the world.">
                  Uses
                </FieldLabel>
                <NumberInput
                  min={1}
                  max={MAX_DURABILITY}
                  step={1}
                  value={extract.durability}
                  onChange={(durability) => patchExtract({ durability })}
                  className="w-20"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel info="Per player, per placement — nobody else sees it. 0 is no wait.">
                  Cooldown (s)
                </FieldLabel>
                <NumberInput
                  min={0}
                  max={MAX_COOLDOWN_SECONDS}
                  step={1}
                  value={extract.cooldownMs / MS_PER_SECOND}
                  onChange={(seconds) =>
                    patchExtract({
                      cooldownMs: Math.round(seconds * MS_PER_SECOND),
                    })
                  }
                  className="w-20"
                  aria-label="Cooldown in seconds"
                />
              </label>
            </div>

            <TileIdMultiSelect
              tiles={others}
              tilesets={tilesets}
              selectedIds={extract.tileId ? [extract.tileId] : []}
              onChange={(ids) => patchExtract({ tileId: ids[0] ?? "" })}
              label="Depleted tile"
              info="To regrow it, give the depleted tile a decay back to this one, or leave this blank and give this tile a respawn."
              emptyHint="None — the placement is removed."
              single
            />

            <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
              <FieldLabel info="Every slot rolls on its own chance, every use. “One to three berries” is three berry slots at descending chances. An empty roll still spends a use.">
                Yield slots
              </FieldLabel>

              {extract.slots.map((slot, index) => (
                <div
                  // By position, on `KitEditor`'s terms: a slot has no identity
                  // of its own, and keying on the tile id would make two rows
                  // offering the same berry collide.
                  key={index}
                  className="flex flex-col gap-2 border-2 border-border bg-paper p-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <FieldLabel>Slot {index + 1}</FieldLabel>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeSlot(index)}
                    >
                      Remove
                    </Button>
                  </div>

                  <label className="flex flex-col gap-1 text-xs">
                    <FieldLabel>Chance (%)</FieldLabel>
                    <NumberInput
                      min={MIN_EXTRACT_CHANCE}
                      max={MAX_EXTRACT_CHANCE}
                      step={1}
                      value={slot.chance}
                      onChange={(chance) => patchSlot(index, { chance })}
                      className="w-20"
                    />
                  </label>

                  <TileIdMultiSelect
                    tiles={giveable}
                    tilesets={tilesets}
                    selectedIds={slot.tileId ? [slot.tileId] : []}
                    onChange={(ids) =>
                      patchSlot(index, { tileId: ids[0] ?? "" })
                    }
                    label="Item"
                    emptyHint="None — the slot is dropped on save."
                    single
                  />
                </div>
              ))}

              {extract.slots.length < MAX_EXTRACT_SLOTS ? (
                <Button variant="secondary" size="sm" onClick={addSlot}>
                  Add slot
                </Button>
              ) : (
                <span className="text-[11px] leading-snug text-muted">
                  Up to {MAX_EXTRACT_SLOTS} slots — the bag must hold every
                  one at once.
                </span>
              )}
            </div>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(teleport)}
          onToggle={(on) =>
            setTeleport(on ? { ...DEFAULT_TELEPORT } : undefined)
          }
          label="Teleport"
          info="Moves whoever triggers it. Repeatable, nothing spent. Refused when the traveller would not fit at the far end."
        />

        {teleport ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel info={TRIGGER_INFO}>Trigger</FieldLabel>
                <Segmented<ActivationTrigger>
                  value={teleport.trigger}
                  onChange={(trigger) => patchTeleport({ trigger })}
                  options={TRIGGER_OPTIONS}
                  size="sm"
                  ariaLabel="Teleport trigger"
                />
              </div>

              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel info="Relative: an offset authored here, the same for every placement — a ladder. Absolute: a cell set on each placement in the map editor — a portal.">
                  Destination
                </FieldLabel>
                <Segmented<TeleportDestinationKind>
                  value={teleport.destination.kind}
                  onChange={setDestinationKind}
                  options={DESTINATION_OPTIONS}
                  size="sm"
                  ariaLabel="Teleport destination kind"
                />
              </div>
            </div>

            {teleport.destination.kind === "relative" ? (
              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel info="Cells from wherever this tile is placed. A ladder up is z +1.">
                  Offset
                </FieldLabel>
                <div className="flex gap-2">
                  {DELTA_AXES.map((axis) => (
                    <label key={axis} className="flex flex-col gap-1">
                      <span className="uppercase text-muted">{axis}</span>
                      <NumberInput
                        step={1}
                        value={delta[axis]}
                        onChange={(value) => patchDelta(axis, value)}
                        className="w-20"
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {teleport.trigger === "step" ? null : (
              <ActionLabelField
                value={teleport.actionName}
                fallback="Enter"
                onChange={(actionName) => patchTeleport({ actionName })}
              />
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(addStatus)}
          onToggle={(on) =>
            setAddStatus(on ? { ...DEFAULT_ADD_STATUS } : undefined)
          }
          label="Apply status"
          info="Puts a status on whoever triggers it. Only a battler takes one. Repeatable. The duration is the status's own, from the Statuses page."
        />

        {addStatus ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel info={TRIGGER_INFO}>Trigger</FieldLabel>
                <Segmented<ActivationTrigger>
                  value={addStatus.trigger}
                  onChange={(trigger) => patchAddStatus({ trigger })}
                  options={TRIGGER_OPTIONS}
                  size="sm"
                  ariaLabel="Status trigger"
                />
              </div>

              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel info="Until one is picked the tile grants nothing and offers no row.">
                  Status
                </FieldLabel>
                {statusOptions.length === 0 ? (
                  <span className="text-[11px] leading-snug text-muted">
                    None authored — see the Statuses page.
                  </span>
                ) : (
                  <Select
                    ariaLabel="Status"
                    value={addStatus.statusId || null}
                    onValueChange={(id) => id && patchAddStatus({ statusId: id })}
                    options={statusOptions}
                  />
                )}
              </div>
            </div>

            {addStatus.trigger === "step" ? null : (
              <ActionLabelField
                value={addStatus.actionName}
                fallback="Touch"
                onChange={(actionName) => patchAddStatus({ actionName })}
              />
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(decay)}
          onToggle={(on) => setDecay(on ? { ...DEFAULT_DECAY } : undefined)}
          label="Decay"
          info="After its lifetime the placement becomes the target tile, or is removed. Chain by giving the target a decay of its own (blood → stain → nothing). Refused when the target would not fit under what is stacked on it; a placement somebody is driving is left alone. Runs in simulated time and keeps the world ticking — keep it short."
        />

        {decay ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs">
              <FieldLabel info="Drawn once per placement, when it appears. Equal ends for an exact lifetime.">
                Lifetime (s)
              </FieldLabel>
              <span className="flex items-center gap-2">
                <NumberInput
                  min={1}
                  max={MAX_DECAY_SECONDS}
                  step={1}
                  value={decay.fromMs / MS_PER_SECOND}
                  onChange={(seconds) => patchDecayBound("fromMs", seconds)}
                  className="w-20"
                  aria-label="Shortest lifetime in seconds"
                />
                <span className="text-muted">to</span>
                <NumberInput
                  min={1}
                  max={MAX_DECAY_SECONDS}
                  step={1}
                  value={decay.toMs / MS_PER_SECOND}
                  onChange={(seconds) => patchDecayBound("toMs", seconds)}
                  className="w-20"
                  aria-label="Longest lifetime in seconds"
                />
              </span>
            </div>

            <TileIdMultiSelect
              tiles={others}
              tilesets={tilesets}
              selectedIds={decay.tileId ? [decay.tileId] : []}
              onChange={(ids) => patchDecay({ tileId: ids[0] ?? "" })}
              label="Becomes"
              emptyHint="None — the placement is removed."
              single
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(plate)}
          onToggle={(on) =>
            setPlate(on ? { ...DEFAULT_PRESSURE_PLATE } : undefined)
          }
          label="Pressure plate"
          info={`Swaps to the target tile whenever the load on its own cell matches. Load is in height units — a stool is 1, a half crate 2, a full level ${HEIGHT_PER_LEVEL}; flat and intangible tiles weigh nothing. Put a plate on both tiles to follow the load (≥ 1 → pressed, ≤ 0 → unpressed); without one on the pressed tile it stays down.`}
        />

        {plate ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel>Swap when load is</FieldLabel>
                <Segmented<PlateComparison>
                  value={plate.type}
                  onChange={(type) => patchPlate({ type })}
                  options={COMPARISON_OPTIONS}
                  size="sm"
                  ariaLabel="Comparison"
                />
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel>Load</FieldLabel>
                <NumberInput
                  min={0}
                  max={MAX_PLATE_HEIGHT}
                  step={1}
                  value={plate.height}
                  onChange={(height) => patchPlate({ height })}
                  className="w-16"
                />
              </label>
            </div>

            <TileIdMultiSelect
              tiles={others}
              tilesets={tilesets}
              selectedIds={plate.tileId ? [plate.tileId] : []}
              onChange={(ids) => patchPlate({ tileId: ids[0] ?? "" })}
              label="Target tile"
              emptyHint="None."
              single
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(emit)}
          onToggle={(on) => setEmit(on ? { ...DEFAULT_EMIT } : undefined)}
          label="Emit"
          info="Drives the placement's signal channel while this tile sits there. The tile is the state, so author both halves — lit torch emits on, unlit emits off — and let a switch or plate move between them. The channel is set per placement in the map editor."
        />

        {emit ? (
          <div className="flex flex-col items-start gap-1 border-t-2 border-border pt-3 text-xs">
            <FieldLabel>Signal</FieldLabel>
            <Segmented<SignalValue>
              value={emit.value}
              onChange={(value) => setEmit({ value })}
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
              size="sm"
              ariaLabel="Signal value"
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionSwitch
          on={Boolean(receive)}
          onToggle={(on) =>
            setReceive(on ? { ...DEFAULT_RECEIVE } : undefined)
          }
          label="Receive"
          info="Swaps to the target tile while its channel reads the chosen value. Pair it like a plate: on → open on the closed door, off → closed on the open one, or it opens once and stays open."
        />

        {receive ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col items-start gap-1 text-xs">
                <FieldLabel>When signal is</FieldLabel>
                <Segmented<SignalValue>
                  value={receive.when}
                  onChange={(when) => patchReceive({ when })}
                  options={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                  size="sm"
                  ariaLabel="Channel reading"
                />
              </div>

              <div className="flex flex-col gap-1 text-xs">
                <FieldLabel info="With several emitters on one channel: any reads on as soon as one is on; all waits for every one. No emitters reads off.">
                  Combine
                </FieldLabel>
                <Segmented<SignalMode>
                  value={receive.mode}
                  onChange={(mode) => patchReceive({ mode })}
                  options={[
                    { value: "any", label: "Any" },
                    { value: "all", label: "All" },
                  ]}
                  size="sm"
                  ariaLabel="Emitter aggregation"
                />
              </div>
            </div>

            <TileIdMultiSelect
              tiles={others}
              tilesets={tilesets}
              selectedIds={receive.tileId ? [receive.tileId] : []}
              onChange={(ids) => patchReceive({ tileId: ids[0] ?? "" })}
              label="Target tile"
              emptyHint="None."
              single
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
