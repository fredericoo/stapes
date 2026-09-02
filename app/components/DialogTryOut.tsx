import { useMemo, useState } from "react";
import {
  acceptTrade,
  cancelTrade,
  chooseOption,
  openConversation,
  type Conversation,
  type DialogEffectDef,
  type PartnerView,
  type TalkAction,
} from "../game/dialogRuntime";
import { emptyEquipment, type Equipment } from "../game/equipment";
import { planTrade } from "../game/trade";
import type { DialogDef } from "../lib/dialog";
import { resolveContainer, resolveItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { Button, Input, Select } from "../ui";
import { ConversationPanel } from "./ConversationPanel";

/**
 * The dialog as a player will meet it, pressed through against a pretend
 * partner.
 *
 * The same `ConversationPanel` the game draws and the same interpreter the
 * server runs, with one substitution: the `PartnerView` answers out of a kit
 * the author fills in here rather than out of a body in the world. The kit
 * is a real `Equipment` — a worn bag of the largest wearable container the
 * catalogue has — so the trade preview's warnings are the trade module's own,
 * and a bag that is full here is full for the same reason it would be online.
 */

const PRETEND_NAME = "you";

type Props = {
  dialog: DialogDef;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statusDefs: Record<string, StatusDef>;
  className?: string;
};

type Pretend = {
  equipment: Equipment;
  tags: Set<string>;
  statuses: Set<string>;
};

/** The roomiest bag a world has to wear, or null for a world with none. */
function biggestBag(tiles: TileDef[]): TileDef | null {
  let best: TileDef | null = null;
  for (const tile of tiles) {
    const container = resolveContainer(tile);
    if (!container?.equippable) continue;
    if (!best || container.size > (resolveContainer(best)?.size ?? 0))
      best = tile;
  }
  return best;
}

let minted = 0;
const mint = () => `pretend_${++minted}`;

function pretendPartner(
  pretend: Pretend,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  apply: (next: Pretend) => void,
): PartnerView {
  return {
    name: () => PRETEND_NAME,
    attempt: (effects) => {
      const next = {
        equipment: pretend.equipment,
        tags: new Set(pretend.tags),
        statuses: new Set(pretend.statuses),
      };
      for (const effect of effects) {
        if (!applyEffect(next, effect, tilesById, statusDefs)) return false;
      }
      apply(next);
      return true;
    },
  };
}

/** One effect on the pretend partner, or false when it cannot be. */
function applyEffect(
  partner: Pretend,
  effect: DialogEffectDef,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): boolean {
  if (effect.effect === "tag") {
    partner.tags.add(effect.tag);
    return true;
  }
  if (effect.effect === "add_status" || effect.effect === "remove_status") {
    if (!statusDefs[effect.statusId]) return false;
    if (effect.effect === "add_status") partner.statuses.add(effect.statusId);
    else partner.statuses.delete(effect.statusId);
    return true;
  }
  const next = planTrade(
    tilesById,
    partner.equipment,
    effect.take,
    effect.give,
    mint,
  );
  if (!next) return false;
  partner.equipment = next;
  return true;
}

export function DialogTryOut({
  dialog,
  tiles,
  tilesets,
  statusDefs,
  className = "",
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const bag = useMemo(() => biggestBag(tiles), [tiles]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [pretend, setPretend] = useState<Pretend>(() => ({
    equipment: bag
      ? {
          ...emptyEquipment(),
          bag: { id: "pretend_bag", tileId: bag.id, contents: [] },
        }
      : emptyEquipment(),
    tags: new Set(),
    statuses: new Set(),
  }));
  const [adding, setAdding] = useState<string | null>(null);

  const itemOptions = tiles
    .filter(
      (tile) => resolveItem(tile) != null && resolveContainer(tile) == null,
    )
    .map((tile) => ({ value: tile.id, label: tile.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const npc = { id: "pretend", tileId: "pretend" };
  const view = pretendPartner(pretend, tilesById, statusDefs, setPretend);

  const talk = (action: TalkAction) => {
    if (action.kind === "open")
      return setConversation(openConversation(dialog, npc, view));
    if (action.kind === "close") return setConversation(null);
    if (!conversation) return;
    const next =
      action.kind === "cancel"
        ? cancelTrade(dialog, conversation, view)
        : action.kind === "trade"
          ? acceptTrade(dialog, conversation, action.amount, view)
          : chooseOption(dialog, conversation, action.index, view);
    if (next) setConversation(next);
  };

  /** Put one more of a thing in the pretend bag, on the trade's landing rule. */
  const addOne = (tileId: string) => {
    const next = planTrade(
      tilesById,
      pretend.equipment,
      [],
      [{ tileId, count: 1 }],
      mint,
    );
    if (next) setPretend({ ...pretend, equipment: next });
  };
  const contents: ItemInstance[] = pretend.equipment.bag?.contents ?? [];

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <h3 className="text-xs font-bold uppercase text-muted">Try it</h3>

      <div className="flex flex-col gap-1 border-2 border-border p-1.5 text-xs">
        <span className="text-[10px] font-bold uppercase text-muted">
          Pretend bag
          {bag
            ? ` — ${bag.name}, ${contents.length}/${resolveContainer(bag)?.size ?? 0}`
            : " — no wearable bag in the catalogue"}
        </span>
        {contents.map((instance) => (
          <div key={instance.id} className="flex items-center gap-2">
            <span className="w-10 tabular-nums">×{instance.count ?? 1}</span>
            <span className="truncate">
              {tilesById[instance.tileId]?.name ?? instance.tileId}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Select
            value={adding}
            onValueChange={setAdding}
            options={itemOptions}
            placeholder="Add a thing…"
            className="min-w-[9rem]"
            ariaLabel="Thing to add to the pretend bag"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!adding}
            onClick={() => adding && addOne(adding)}
          >
            +1
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setPretend({
                ...pretend,
                equipment: {
                  ...pretend.equipment,
                  bag: pretend.equipment.bag && {
                    ...pretend.equipment.bag,
                    contents: [],
                  },
                },
              })
            }
          >
            Empty
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase text-muted">tags</span>
          <Input
            value={[...pretend.tags].join(", ")}
            onChange={(e) =>
              setPretend({
                ...pretend,
                tags: new Set(
                  e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                ),
              })
            }
            className="w-40"
            placeholder="none"
            aria-label="Pretend tags, comma separated"
          />
        </div>
        {Object.keys(statusDefs).length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase text-muted">statuses</span>
            {Object.values(statusDefs).map((def) => (
              <Button
                key={def.id}
                size="sm"
                variant="secondary"
                active={pretend.statuses.has(def.id)}
                onClick={() =>
                  setPretend({
                    ...pretend,
                    statuses: toggled(pretend.statuses, def.id),
                  })
                }
              >
                {def.name}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {/* The game's own colours, so the panel here is the panel there. */}
      <div className="flex min-h-40 flex-col gap-2 bg-ink p-2 text-paper">
        {conversation ? (
          <ConversationPanel
            conversation={conversation}
            dialog={dialog}
            title="This body"
            tiles={tiles}
            tilesets={tilesets}
            equipment={pretend.equipment}
            onTalk={talk}
          />
        ) : (
          <button
            type="button"
            onClick={() =>
              talk({ kind: "open", ref: { x: 0, y: 0, z: 0, stackIndex: 0 } })
            }
            className="flex min-h-9 items-center justify-center border border-paper/30 px-2 text-[11px] font-medium text-paper hover:border-paper hover:bg-paper/10"
          >
            Talk
          </button>
        )}
      </div>
    </div>
  );
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
