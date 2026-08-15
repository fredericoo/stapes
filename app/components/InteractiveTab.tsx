import type {
  ClimbAbility,
  EmitInteraction,
  PlateComparison,
  PressurePlateInteraction,
  PushInteraction,
  ReceiveInteraction,
  SignalMode,
  SignalValue,
  SwitchInteraction,
  TileInteractions,
} from "../lib/interactions";
import {
  DEFAULT_EMIT,
  DEFAULT_PRESSURE_PLATE,
  DEFAULT_PUSH,
  DEFAULT_RECEIVE,
  DEFAULT_SWITCH,
  hasAnyInteraction,
} from "../lib/interactions";
import { DEFAULT_BATTLER } from "../lib/battler";
import { DEFAULT_WEAPON } from "../lib/item";
import type { TileDef, TileKind, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { Input, Segmented, Switch } from "../ui";
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

/** Deepest a plate can be buried: a stack may overflow one level into the next. */
const MAX_PLATE_HEIGHT = HEIGHT_PER_LEVEL * 2;

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
