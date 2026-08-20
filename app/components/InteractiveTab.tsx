import type {
  ClimbAbility,
  DecayInteraction,
  EmitInteraction,
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
  TeleportTrigger,
  TileInteractions,
  Transmutation,
  TransmuteInteraction,
} from "../lib/interactions";
import {
  DEFAULT_DECAY,
  DEFAULT_EMIT,
  DEFAULT_PRESSURE_PLATE,
  DEFAULT_PUSH,
  DEFAULT_RECEIVE,
  DEFAULT_REWARD,
  DEFAULT_SWITCH,
  DEFAULT_TELEPORT,
  DEFAULT_TRANSMUTATION,
  DEFAULT_TRANSMUTE,
  DEFAULT_TRANSMUTE_VERB,
  MAX_REWARD_ITEMS,
  MAX_TRANSMUTATION_OUTPUTS,
  MAX_TRANSMUTATIONS,
  hasAnyInteraction,
} from "../lib/interactions";
import { DEFAULT_BATTLER } from "../lib/battler";
import { DEFAULT_WEAPON, resolveContainer, resolveItem } from "../lib/item";
import type { TileDef, TileKind, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { Button, Input, Segmented, Switch } from "../ui";
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

const TRIGGER_OPTIONS: Array<{ value: TeleportTrigger; label: string }> = [
  { value: "step", label: "Step on" },
  { value: "interact", label: "Press beside" },
  { value: "interactOver", label: "Press on" },
];

/** What choosing each trigger gets you, in one line under the control. */
const TRIGGER_HINTS: Record<TeleportTrigger, string> = {
  step: "Walking onto it does it, with nothing to press — a portal you fall through. No row, no outline: it has already happened by the time you could read about it.",
  interact:
    "Pressing it from the next square over, squarely — the same reach a switch takes. A doorway you step into.",
  interactOver:
    "Pressing it while standing on it. A ladder: you walk onto the rungs, then climb.",
};

const DESTINATION_OPTIONS: Array<{
  value: TeleportDestinationKind;
  label: string;
}> = [
  { value: "relative", label: "An offset" },
  { value: "absolute", label: "A cell" },
];

/** Which half of the authoring holds the answer, in one line under the control. */
const DESTINATION_HINTS: Record<TeleportDestinationKind, string> = {
  relative:
    "The same journey wherever this tile is dropped, set here and once. A ladder goes up one floor, whichever ladder it is.",
  absolute:
    "A different cell for every placement, set on each one in the map editor. One portal tile can be every doorway in the world.",
};

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

/** A cleared number field reads as the shortest legal lifetime, not as NaN. */
function secondsFromInput(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? 1 : parsed;
}

const KIND_OPTIONS: Array<{ value: TileKind; label: string }> = [
  { value: "prop", label: "Prop" },
  { value: "battler", label: "Battler" },
  { value: "item", label: "Item" },
];

/** What choosing each kind gets you, in one line under the select. */
const KIND_HINTS: Record<TileKind, string> = {
  prop: "Scenery and machinery — everything the world is made of. It can still be pushed, switched, wired, and driven by a brain.",
  battler: "It has hit points, and can be targeted, hurt and killed. Stats are on the Battle tab.",
  item: "It can be picked up and carried. What it does in a bag or a hand is on the Item tab.",
};

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
};

/**
 * Ways the player can interact with this tile in play mode. One section per
 * interaction kind.
 */
export function InteractiveTab({ draft, onChange, tiles, tilesets }: Props) {
  const push = draft.interactions?.push;
  const sw = draft.interactions?.switch;
  const reward = draft.interactions?.reward;
  const transmute = draft.interactions?.transmute;
  const teleport = draft.interactions?.teleport;
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

  /** A cleared axis reads as 0 rather than as NaN, like every number here. */
  const patchDelta = (axis: (typeof DELTA_AXES)[number], raw: string) => {
    if (teleport?.destination.kind !== "relative") return;
    const parsed = Number.parseInt(raw, 10);
    patchTeleport({
      destination: {
        kind: "relative",
        delta: { ...delta, [axis]: Number.isInteger(parsed) ? parsed : 0 },
      },
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

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-sm font-bold">Kind</span>
          <p className="text-[11px] leading-snug text-muted">
            What this tile <em>is</em>, as opposed to what it does. The three are
            exclusive, and each opens the tab that configures it. Everything
            below — push, switch, plates, wires — is available whichever you
            pick.
          </p>
          <div className="pt-1">
            <Segmented<TileKind>
              value={draft.kind}
              onChange={setKind}
              options={KIND_OPTIONS}
              size="sm"
              ariaLabel="Tile kind"
            />
          </div>
          <span className="text-[11px] leading-snug text-muted">
            {KIND_HINTS[draft.kind]}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(push)}
            onCheckedChange={(on) => setPush(on ? { ...DEFAULT_PUSH } : undefined)}
            ariaLabel="Pushable"
          />
          Push
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Standing next to this object and clicking it shoves it one cell
          straight away from the player. Never diagonally, never further than
          one cell — where it goes is decided by where the player stands.
        </p>

        {push ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">
                Climb height
              </span>
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
              <span className="text-[11px] leading-snug text-muted">
                How far up it can be shoved. When the cell ahead offers both a
                step up and a step down it takes the step down. Going down is
                physics — turn on <strong>Affected by gravity</strong> on the
                Tile tab to let it be pushed off ledges.
              </span>
            </div>

            <TileIdMultiSelect
              tiles={tiles}
              tilesets={tilesets}
              selectedIds={push.moveOnTileIds}
              onChange={(moveOnTileIds) => patchPush({ moveOnTileIds })}
              label="Move on tiles"
              emptyHint="Any surface. Pick tiles to confine this object to them — it can only come to rest on top of one of the chosen tiles."
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(sw)}
            onCheckedChange={(on) =>
              setSwitch(on ? { ...DEFAULT_SWITCH } : undefined)
            }
            ariaLabel="Switchable"
          />
          Switch
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Clicking this object replaces it with another tile. Put switch on
          both tiles to toggle (e.g. door closed ↔ open). The swap is refused
          when the target would not fit in the stack. A tile with both switch
          and push switches — push is the fallback.
        </p>

        {sw ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <TileIdMultiSelect
              tiles={tiles.filter((t) => t.id !== draft.id)}
              tilesets={tilesets}
              selectedIds={sw.targetTileId ? [sw.targetTileId] : []}
              onChange={(ids) =>
                patchSwitch({ targetTileId: ids[0] ?? "" })
              }
              label="Target tile"
              emptyHint="Pick the tile this becomes when switched."
              single
            />
            <label className="flex flex-col gap-1 text-xs font-bold">
              Action name
              <Input
                value={sw.actionName ?? ""}
                onChange={(e) => patchSwitch({ actionName: e.target.value })}
                placeholder="Switch"
              />
              <span className="text-[11px] font-normal leading-snug text-muted">
                What the player is doing, as they would say it — “Open” on a
                shut door and “Close” on an open one. Shown wherever the action
                is offered by name rather than by pointing at it. Leave it blank
                and it reads as “Switch”.
              </span>
            </label>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(reward)}
            onCheckedChange={(on) =>
              setReward(on ? { ...DEFAULT_REWARD } : undefined)
            }
            ariaLabel="Gives a reward"
          />
          Reward
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Hands the player items, <strong>once each</strong>. A quest chest, or
          a person who gives you something. The tile itself never changes — it
          is still there, still full, for everybody else — so what stops a
          second helping is a tag written on the player. Offered in purple, and
          refused outright when the bag has no room for all of it.
        </p>
        <p className="text-[11px] leading-snug text-muted">
          <strong>What it gives is set per placement</strong>, not here — the
          same way a signal channel is. One chest tile can be every chest in the
          world, each with its own loot and its own tag. Select a placement in
          the map editor and open its settings.
        </p>

        {reward ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <label className="flex flex-col gap-1 text-xs font-bold">
              Action name
              <Input
                value={reward.actionName ?? ""}
                onChange={(e) => patchReward({ actionName: e.target.value })}
                placeholder="Take"
              />
              <span className="text-[11px] font-normal leading-snug text-muted">
                What the player is doing, as they would say it — “Open” on a
                chest, “Receive” from a person. The one part that belongs to the
                tile rather than to the spot: every chest cut from this tile is
                opened, whatever is inside them. Leave it blank and it reads as
                “Take”.
              </span>
            </label>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(transmute)}
            onCheckedChange={(on) =>
              setTransmute(on ? { recipes: [...DEFAULT_TRANSMUTE.recipes] } : undefined)
            }
            ariaLabel="Transmutes"
          />
          Transmute
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Turns one thing the player is carrying into one or more others — a
          fire that cooks meat, a trader who takes a carcass for a coin. The
          input is destroyed and what comes back is minted fresh, so this is a
          recipe rather than an exchange of particular objects.
        </p>
        <p className="text-[11px] leading-snug text-muted">
          <strong>The tile never changes and nothing is spent but the input.</strong>{" "}
          Unlike a reward it is not once per player: the fire cooks the second
          steak too, and what limits it is having something to spend. A recipe is
          only offered while the player is actually carrying its input, so a fire
          you have nothing to cook at is just a fire.
        </p>

        {transmute ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            {transmute.recipes.map((recipe, index) => (
              <div
                key={index}
                className="flex flex-col gap-3 border-2 border-border bg-paper p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-bold uppercase text-muted">
                    Recipe {index + 1}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRecipe(index)}
                  >
                    Remove
                  </Button>
                </div>

                <label className="flex flex-col gap-1 text-xs font-bold">
                  Verb
                  <Input
                    value={recipe.verb ?? ""}
                    onChange={(e) => patchRecipe(index, { verb: e.target.value })}
                    placeholder={DEFAULT_TRANSMUTE_VERB}
                  />
                  <span className="text-[11px] font-normal leading-snug text-muted">
                    What the player is doing, as they would say it — “Cook” at a
                    fire, “Trade” with a salesman. The row reads as the verb and
                    the thing being spent, so this one says “Cook Raw Meat”. Per
                    recipe rather than per tile, because one stall may both trade
                    and cook. Leave it blank and it reads as “{DEFAULT_TRANSMUTE_VERB}”.
                  </span>
                </label>

                <TileIdMultiSelect
                  tiles={tiles.filter(isGiveable)}
                  tilesets={tilesets}
                  selectedIds={recipe.fromTileId ? [recipe.fromTileId] : []}
                  onChange={(ids) =>
                    patchRecipe(index, { fromTileId: ids[0] ?? "" })
                  }
                  label="Spends"
                  emptyHint="Pick the item this takes. It is looked for in the player’s hands first, then in their bag."
                  single
                />

                <TileIdMultiSelect
                  tiles={tiles.filter(isGiveable)}
                  tilesets={tilesets}
                  selectedIds={recipe.toTileIds}
                  onChange={(toTileIds) =>
                    patchRecipe(index, {
                      toTileIds: toTileIds.slice(0, MAX_TRANSMUTATION_OUTPUTS),
                    })
                  }
                  label="Gives back"
                  emptyHint="Pick what comes back. Nothing here means the recipe does nothing, and it is dropped on save."
                />
                <span className="text-[11px] leading-snug text-muted">
                  <strong>It goes back where the input came from</strong> — the
                  hand that held it out, or the pack it was taken from, counting
                  the square the input frees. Whatever will not fit there spills
                  to the rest of the kit, pack before hands, and{" "}
                  <strong>never onto the floor</strong>: a recipe with nowhere
                  left on the body to put its results is not offered at all. Up
                  to {MAX_TRANSMUTATION_OUTPUTS}, and never a container: nothing
                  nests.
                </span>
              </div>
            ))}

            {transmute.recipes.length < MAX_TRANSMUTATIONS ? (
              <Button variant="secondary" size="sm" onClick={addRecipe}>
                Add recipe
              </Button>
            ) : (
              <span className="text-[11px] leading-snug text-muted">
                {MAX_TRANSMUTATIONS} recipes is the most one tile may offer —
                every runnable one is a row in the player’s list, and a menu
                longer than this has stopped being something you can scan.
              </span>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(teleport)}
            onCheckedChange={(on) =>
              setTeleport(on ? { ...DEFAULT_TELEPORT } : undefined)
            }
            ariaLabel="Teleports"
          />
          Teleport
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Puts whoever sets it off somewhere else on the board — a portal, a
          ladder, a trapdoor. Nothing is spent and nothing is remembered: walk
          back onto it and you go through again. Refused outright when the
          traveller would not fit at the far end.
        </p>
        <p className="text-[11px] leading-snug text-muted">
          <strong>Where it leads is set by whichever half actually varies.</strong>{" "}
          A ladder makes the same journey wherever it is dropped, so its offset
          lives here and is authored once. A portal leads somewhere different
          from every doorway, so its target lives on each placement — select one
          in the map editor and open its settings.
        </p>

        {teleport ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs font-bold">
              Trigger
              <Segmented<TeleportTrigger>
                value={teleport.trigger}
                onChange={(trigger) => patchTeleport({ trigger })}
                options={TRIGGER_OPTIONS}
                size="sm"
                ariaLabel="Teleport trigger"
              />
              <span className="text-[11px] font-normal leading-snug text-muted">
                {TRIGGER_HINTS[teleport.trigger]}
              </span>
            </div>

            <div className="flex flex-col gap-1 text-xs font-bold">
              Destination is
              <Segmented<TeleportDestinationKind>
                value={teleport.destination.kind}
                onChange={setDestinationKind}
                options={DESTINATION_OPTIONS}
                size="sm"
                ariaLabel="Teleport destination kind"
              />
              <span className="text-[11px] font-normal leading-snug text-muted">
                {DESTINATION_HINTS[teleport.destination.kind]}
              </span>
            </div>

            {teleport.destination.kind === "relative" ? (
              <div className="flex flex-col gap-1 text-xs font-bold">
                Offset
                <div className="flex gap-2">
                  {DELTA_AXES.map((axis) => (
                    <label key={axis} className="flex flex-1 flex-col gap-1">
                      <span className="uppercase text-muted">{axis}</span>
                      <Input
                        type="number"
                        step={1}
                        value={String(delta[axis])}
                        onChange={(e) => patchDelta(axis, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <span className="text-[11px] font-normal leading-snug text-muted">
                  How far this moves somebody, from wherever it is placed. A
                  ladder up is <strong>z + 1</strong> and a ladder down is{" "}
                  <strong>z − 1</strong>. Every copy of this tile travels the
                  same distance, which is what makes a ladder a tile you can
                  drop anywhere.
                </span>
              </div>
            ) : null}

            {teleport.trigger === "step" ? null : (
              <label className="flex flex-col gap-1 text-xs font-bold">
                Action name
                <Input
                  value={teleport.actionName ?? ""}
                  onChange={(e) =>
                    patchTeleport({ actionName: e.target.value })
                  }
                  placeholder="Enter"
                />
                <span className="text-[11px] font-normal leading-snug text-muted">
                  What the player is doing, as they would say it — “Enter” a
                  portal, “Climb” a ladder. The one part that belongs to the tile
                  rather than to the spot: every ladder cut from this tile is
                  climbed, wherever they go. Leave it blank and it reads as
                  “Enter”.
                </span>
              </label>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(decay)}
            onCheckedChange={(on) =>
              setDecay(on ? { ...DEFAULT_DECAY } : undefined)
            }
            ariaLabel="Decays over time"
          />
          Decay
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Switch, but the input is time rather than a click. After its lifetime
          the placement becomes another tile — or goes away, if you leave the
          target blank. Chain it by giving that tile a decay of its own (blood →
          stain → nothing). The swap is refused when the target would not fit
          under whatever has been stacked on it, and a placement somebody is
          driving is left alone.
        </p>

        {decay ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Lifetime</span>
              <span className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={MAX_DECAY_SECONDS}
                  step={1}
                  value={decay.fromMs / MS_PER_SECOND}
                  onChange={(e) =>
                    patchDecayBound("fromMs", secondsFromInput(e.target.value))
                  }
                  className="w-20"
                  aria-label="Shortest lifetime in seconds"
                />
                <span className="font-normal text-muted">to</span>
                <Input
                  type="number"
                  min={1}
                  max={MAX_DECAY_SECONDS}
                  step={1}
                  value={decay.toMs / MS_PER_SECOND}
                  onChange={(e) =>
                    patchDecayBound("toMs", secondsFromInput(e.target.value))
                  }
                  className="w-20"
                  aria-label="Longest lifetime in seconds"
                />
                <span className="font-normal text-muted">seconds</span>
              </span>
              <span className="text-[11px] font-normal leading-snug text-muted">
                Each placement draws its own lifetime from this range when it
                appears, and keeps it. A spread is what stops a burst of blood
                from one fight vanishing all on the same frame — set both ends
                the same for an exact lifetime. Counted in simulated time, so it
                does not run on while the world is empty, and a world with
                anything decaying in it keeps ticking until the longest of these
                is up. Keep it short: this is meant for blood and bodies, not
                for weathering a wall.
              </span>
            </div>

            <TileIdMultiSelect
              tiles={tiles.filter((t) => t.id !== draft.id)}
              tilesets={tilesets}
              selectedIds={decay.tileId ? [decay.tileId] : []}
              onChange={(ids) => patchDecay({ tileId: ids[0] ?? "" })}
              label="Becomes"
              emptyHint="Nothing — the placement is removed when its time is up. Pick a tile to leave something behind instead."
              single
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(plate)}
            onCheckedChange={(on) =>
              setPlate(on ? { ...DEFAULT_PRESSURE_PLATE } : undefined)
            }
            ariaLabel="Pressure plate"
          />
          Pressure plate
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Swaps itself for another tile whenever the load stacked on top of it
          matches. The player never clicks it — the board pressing on it is the
          whole input. Put a plate on both tiles to follow the load (unpressed{" "}
          <strong>≥ 1</strong> → pressed, pressed <strong>≤ 0</strong> →
          unpressed); leave the pressed tile without one and it stays down for
          good.
        </p>

        {plate ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase text-muted">
                  Swap when load is
                </span>
                <Segmented<PlateComparison>
                  value={plate.type}
                  onChange={(type) => patchPlate({ type })}
                  options={COMPARISON_OPTIONS}
                  size="sm"
                  ariaLabel="Comparison"
                />
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase text-muted">Height</span>
                <Input
                  type="number"
                  min={0}
                  max={MAX_PLATE_HEIGHT}
                  step={1}
                  value={plate.height}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    const height = Number.isNaN(parsed) ? 0 : parsed;
                    patchPlate({
                      height: Math.min(MAX_PLATE_HEIGHT, Math.max(0, height)),
                    });
                  }}
                  className="w-16"
                />
              </label>
            </div>

            <span className="text-[11px] leading-snug text-muted">
              Load is measured in height units: a half-height crate is 1, the
              player and a full level are {HEIGHT_PER_LEVEL}. Flat and
              intangible tiles weigh nothing, so <strong>≥ 1</strong> reads as
              “something solid is standing here”. Only this cell’s own stack
              counts.
            </span>

            <TileIdMultiSelect
              tiles={tiles.filter((t) => t.id !== draft.id)}
              tilesets={tilesets}
              selectedIds={plate.tileId ? [plate.tileId] : []}
              onChange={(ids) => patchPlate({ tileId: ids[0] ?? "" })}
              label="Swap to"
              emptyHint="Pick the tile this becomes while the comparison holds."
              single
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(emit)}
            onCheckedChange={(on) => setEmit(on ? { ...DEFAULT_EMIT } : undefined)}
            ariaLabel="Emits a signal"
          />
          Emit
        </label>
        <p className="text-[11px] leading-snug text-muted">
          While this tile sits on a placement with a channel, it drives that
          channel. The tile <em>is</em> the state, so author both halves — torch
          lit emits <strong>on</strong>, torch unlit emits <strong>off</strong>{" "}
          — and let switch or pressure plate move between them. Which channel is
          picked per placement in the map editor, not here.
        </p>

        {emit ? (
          <div className="flex flex-col items-start gap-1 border-t-2 border-border pt-3 text-xs">
            <span className="font-bold uppercase text-muted">Drives channel</span>
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
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(receive)}
            onCheckedChange={(on) =>
              setReceive(on ? { ...DEFAULT_RECEIVE } : undefined)
            }
            ariaLabel="Receives a signal"
          />
          Receive
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Swaps itself for another tile while its channel reads a given way — a
          pressure plate or lit torch somewhere else on the map is the whole
          input. Same pairing as a pressure plate: author{" "}
          <strong>on → open</strong> on the closed door and{" "}
          <strong>off → closed</strong> on the open one, or it opens once and
          stays open.
        </p>

        {receive ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col items-start gap-1 text-xs">
                <span className="font-bold uppercase text-muted">
                  Swap when channel is
                </span>
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
                <span className="font-bold uppercase text-muted">Emitters</span>
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

            <span className="text-[11px] leading-snug text-muted">
              With several emitters on one channel, <strong>any</strong> reads
              on as soon as one of them is on; <strong>all</strong> waits for
              every one. A channel with no emitters at all reads off.
            </span>

            <TileIdMultiSelect
              tiles={tiles.filter((t) => t.id !== draft.id)}
              tilesets={tilesets}
              selectedIds={receive.tileId ? [receive.tileId] : []}
              onChange={(ids) => patchReceive({ tileId: ids[0] ?? "" })}
              label="Swap to"
              emptyHint="Pick the tile this becomes while the channel matches."
              single
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
