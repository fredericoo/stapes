import { useState } from "react";
import {
  chooseOption,
  confirmAmount,
  goBack,
  openConversation,
  type Conversation,
  type PartnerView,
  type TalkAction,
} from "../game/dialogRuntime";
import type { DialogDef, DialogEffectDef } from "../lib/dialog";
import { resolveItem } from "../lib/item";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, Input, Select } from "../ui";
import { ConversationPanel } from "./ConversationPanel";

/**
 * The dialog as a player will meet it, pressed through against a pretend
 * partner.
 *
 * The same `ConversationPanel` the game draws and the same runtime the server
 * runs — `openConversation`, `chooseOption`, `confirmAmount`, `goBack` —
 * with one substitution: the `PartnerView` answers out of a bag the author
 * fills in here rather than out of a body in the world. So what a press does
 * on this page is what it will do online, and an author sees a refusal line
 * without walking a character up to a counter with the wrong number of shards.
 *
 * The pretend bag is deliberately simpler than a kit: things and counts, with
 * room for anything given. Whether fourteen shards fit in a real bag is the
 * trade module's question, tested there; what this answers is whether the
 * tree reads right.
 */

const PRETEND_NAME = "you";

type Bag = Record<string, number>;

type Props = {
  dialog: DialogDef;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statusDefs: Record<string, StatusDef>;
  className?: string;
};

/** A pretend partner, and what each press did to them. */
function pretendPartner(
  bag: Bag,
  tags: ReadonlySet<string>,
  statuses: ReadonlySet<string>,
  statusDefs: Record<string, StatusDef>,
  apply: (next: { bag: Bag; tags: Set<string>; statuses: Set<string> }) => void,
): PartnerView {
  return {
    name: () => PRETEND_NAME,
    carries: (tileId, count) => (bag[tileId] ?? 0) >= count,
    roomFor: () => true,
    hasTag: (tag) => tags.has(tag),
    hasStatus: (statusId) => statuses.has(statusId),
    attempt: (effects) => {
      const next = { bag: { ...bag }, tags: new Set(tags), statuses: new Set(statuses) };
      for (const effect of effects) {
        if (!applyEffect(next, effect, statusDefs)) return false;
      }
      apply(next);
      return true;
    },
  };
}

/** One effect on the pretend partner, or false when it cannot be. */
function applyEffect(
  partner: { bag: Bag; tags: Set<string>; statuses: Set<string> },
  effect: DialogEffectDef,
  statusDefs: Record<string, StatusDef>,
): boolean {
  if (effect.effect === "tag") {
    partner.tags.add(effect.tag);
    return true;
  }
  if (effect.effect === "add_status") {
    if (!statusDefs[effect.statusId]) return false;
    partner.statuses.add(effect.statusId);
    return true;
  }
  for (const side of effect.take) {
    if ((partner.bag[side.tileId] ?? 0) < side.count) return false;
  }
  for (const side of effect.take) partner.bag[side.tileId]! -= side.count;
  for (const side of effect.give) partner.bag[side.tileId] = (partner.bag[side.tileId] ?? 0) + side.count;
  for (const [tileId, count] of Object.entries(partner.bag)) {
    if (count <= 0) delete partner.bag[tileId];
  }
  return true;
}

export function DialogTryOut({ dialog, tiles, tilesets, statusDefs, className = "" }: Props) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [bag, setBag] = useState<Bag>({});
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);

  const itemOptions = tiles
    .filter((tile) => resolveItem(tile) != null)
    .map((tile) => ({ value: tile.id, label: tile.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const npc = { id: "pretend", tileId: "pretend" };

  const view = pretendPartner(bag, tags, statuses, statusDefs, (next) => {
    setBag(next.bag);
    setTags(next.tags);
    setStatuses(next.statuses);
  });

  const talk = (action: TalkAction) => {
    if (action.kind === "open") return setConversation(openConversation(dialog, npc, view));
    if (action.kind === "close") return setConversation(null);
    if (!conversation) return;
    const next =
      action.kind === "back"
        ? goBack(dialog, conversation, view)
        : action.kind === "confirm"
          ? confirmAmount(dialog, conversation, action.amount, view)
          : chooseOption(dialog, conversation, action.index, view);
    if (next) setConversation(next);
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <h3 className="text-xs font-bold uppercase text-muted">Try it</h3>

      <div className="flex flex-col gap-1 border-2 border-border p-1.5 text-xs">
        <span className="text-[10px] font-bold uppercase text-muted">Pretend bag</span>
        {Object.entries(bag).map(([tileId, count]) => (
          <div key={tileId} className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              value={count}
              onChange={(e) => setBag(withCount(bag, tileId, Number(e.target.value) || 0))}
              className="w-16"
              aria-label={`How many ${tileId}`}
            />
            <span className="truncate">{tiles.find((t) => t.id === tileId)?.name ?? tileId}</span>
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
            onClick={() => adding && setBag(withCount(bag, adding, (bag[adding] ?? 0) + 1))}
          >
            +1
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase text-muted">tags</span>
          <Input
            value={[...tags].join(", ")}
            onChange={(e) =>
              setTags(new Set(e.target.value.split(",").map((t) => t.trim()).filter(Boolean)))
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
                active={statuses.has(def.id)}
                onClick={() => setStatuses(toggled(statuses, def.id))}
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
            onTalk={talk}
          />
        ) : (
          <button
            type="button"
            onClick={() => talk({ kind: "open", ref: { x: 0, y: 0, z: 0, stackIndex: 0 } })}
            className="flex min-h-9 items-center justify-center border border-paper/30 px-2 text-[11px] font-medium text-paper hover:border-paper hover:bg-paper/10"
          >
            Talk
          </button>
        )}
      </div>
    </div>
  );
}

function withCount(bag: Bag, tileId: string, count: number): Bag {
  const next = { ...bag };
  if (count <= 0) delete next[tileId];
  else next[tileId] = count;
  return next;
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
