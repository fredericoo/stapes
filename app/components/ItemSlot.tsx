import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { stoneLocked, takesEffect, type Equipment } from "../game/equipment";
import { itemCard } from "../game/itemCard";
import { isBodySlot, slotKey, type SlotRef } from "../game/itemMoves";
import { itemUseFor } from "../game/itemUse";
import { consumeVerb, equipVerb, resolveConsumable } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { engravedName } from "../lib/engraving";
import { pileTally } from "../lib/piles";
import { masteriesFromXp, type MasteryXp } from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import type { StatusDef } from "../lib/status";
import { DWELL_MS } from "../lib/useDwell";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { Tooltip } from "../ui";
import { ItemCard } from "./ItemCard";
import type { ItemDrag } from "./useItemDrag";
import { TilePreview } from "./TilePreview";

const FRONT = "s" as const;

const NO_STATUS_DEFS: Record<string, StatusDef> = {};

export const ITEM_SLOT_SIZE_PX = 44;

const SPRITE_SHARE = 32 / ITEM_SLOT_SIZE_PX;

const EMPTY_ICON_SHARE = 20 / ITEM_SLOT_SIZE_PX;

const EMPTY_ICON_STROKE = 1.5;

const LOCKED_NOTE = "Still cooling; it cannot be moved yet";

const IDLE_NOTE = "Doing nothing there";

function pressHintFor(
  instance: ItemInstance | null,
  slot: SlotRef,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  open: boolean | undefined,
): string | null {
  if (!instance) return null;
  const use = itemUseFor(instance, slot, tilesById, equipment);
  if (!use) return null;
  if (use.type === "open") return open ? "Press to close it." : "Press to open it.";
  if (use.type === "consume") {
    const def = tilesById[instance.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    const verb = consumable ? consumeVerb(consumable) : null;
    return verb ? `Press to ${verb.toLocaleLowerCase()} it.` : null;
  }
  if (use.to.kind === "contents") return "Press to put it away.";
  const def = tilesById[instance.tileId];
  return def ? `Press to ${equipVerb(def).toLocaleLowerCase()} it.` : null;
}

export type SlotAppearance =
  | "landing"
  | "candidate"
  | "source"
  | "open"
  | "locked"
  | "idle"
  | "filled"
  | "empty";

export function slotAppearance({
  isOver,
  wouldTake,
  isSource,
  isOpen,
  locked,
  idle,
  filled,
}: {
  isOver: boolean;
  wouldTake: boolean;
  isSource: boolean;
  isOpen: boolean;
  locked: boolean;
  idle: boolean;
  filled: boolean;
}): SlotAppearance {
  if (isOver) return "landing";
  if (wouldTake) return "candidate";
  if (isSource) return "source";
  if (isOpen) return "open";
  if (locked) return "locked";
  if (idle) return "idle";
  return filled ? "filled" : "empty";
}

const SLOT_APPEARANCE_CLASSES: Record<SlotAppearance, string> = {
  landing: "border-accent bg-accent/30",
  candidate: "border-accent/60 bg-accent/10",
  source: "border-dashed border-paper/60 bg-paper/5 opacity-50",
  open: "border-interact bg-interact/20",
  locked: "border-paper/25 bg-paper/5 opacity-60",
  idle: "border-paper/20 bg-transparent hover:border-paper/50",
  filled: "border-paper/60 bg-paper/10 hover:border-paper",
  empty: "border-dashed border-paper/25 bg-transparent",
};

function slotLabelFor(instance: ItemInstance, tile: TileDef | null): string {
  const name = engravedName(tile?.name ?? instance.tileId, instance.engraved);
  if (instance.engraved) return name;
  return instance.inscription?.trim() || name;
}

export function ItemSlot({
  slot,
  instance,
  equipment,
  tilesById,
  tilesets,
  label,
  emptyHint,
  emptyIcon: EmptyIcon,
  open,
  drag,
  masteryXp = {},
  statusDefs = NO_STATUS_DEFS,
  sizePx = ITEM_SLOT_SIZE_PX,
  spilledInto = null,
}: {
  slot: SlotRef;
  instance: ItemInstance | null;
  equipment: Equipment;
  spilledInto?: ItemInstance | null;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  label: string;
  emptyHint?: string;
  emptyIcon?: ComponentType<{ size?: number; stroke?: number; className?: string }>;
  open?: boolean | undefined;
  drag: ItemDrag;
  masteryXp?: MasteryXp;
  statusDefs?: Record<string, StatusDef>;
  sizePx?: number;
}) {
  const tile = instance ? (tilesById[instance.tileId] ?? null) : null;
  const spilledTile = !instance && spilledInto ? (tilesById[spilledInto.tileId] ?? null) : null;
  const tally = instance ? pileTally(instance) : null;
  const name = instance
    ? [slotLabelFor(instance, tile), tally].filter(Boolean).join(" ")
    : spilledTile
      ? `both hands on the ${spilledTile.name}`
      : "empty";

  const key = slotKey(slot);
  const { register, startDrag, tap } = drag;
  const attach = useCallback((el: HTMLElement | null) => register(key, slot, el), [key, register]);

  const coarse = useCoarsePointer();
  const [pointedAt, setPointedAt] = useState(false);
  const [dwelling, setDwelling] = useState(false);
  const dwellingRef = useRef(false);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swallowClick = useRef(false);

  const endDwell = useCallback(() => {
    if (dwellTimer.current !== null) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    if (!dwellingRef.current) return;
    dwellingRef.current = false;
    swallowClick.current = true;
    setDwelling(false);
  }, []);

  const dragging = drag.held != null;
  useEffect(() => {
    if (dragging) endDwell();
  }, [dragging, endDwell]);

  useEffect(() => endDwell, [endDwell]);
  const masteries = useMemo(() => masteriesFromXp(masteryXp), [masteryXp]);

  const asking = dwelling || (!coarse && pointedAt);
  const inspected = useMemo(() => {
    if (!asking || !tile) return null;
    const card = itemCard(tile, instance, masteryXp, statusDefs);
    return card ? { card, tile } : null;
  }, [asking, tile, instance, masteryXp, statusDefs]);

  const held = drag.held;
  const isSource = held != null && slotKey(held.from) === key;
  const wouldTake = drag.targets.has(key) && !isSource;
  const isOver = drag.over === key;
  const locked = stoneLocked(instance, tilesById);
  const idle =
    instance != null && isBodySlot(slot) && !takesEffect(slot.kind, instance, tilesById, masteries);
  const isOpen = instance ? open : undefined;
  const pressHint = pressHintFor(instance, slot, tilesById, equipment, isOpen);
  const showTooltip = inspected != null && asking;

  const square = (
    <button
      type="button"
      ref={attach}
      onPointerDown={(event) => {
        if (instance) startDrag(event, slot, instance);
        if (coarse && instance) {
          dwellTimer.current = setTimeout(() => {
            dwellTimer.current = null;
            dwellingRef.current = true;
            setDwelling(true);
          }, DWELL_MS);
        }
      }}
      onPointerUp={endDwell}
      onPointerCancel={endDwell}
      onClick={() => {
        if (swallowClick.current) {
          swallowClick.current = false;
          return;
        }
        tap(slot, instance);
      }}
      onPointerEnter={() => setPointedAt(true)}
      onPointerLeave={() => {
        setPointedAt(false);
        endDwell();
      }}
      onFocus={() => setPointedAt(true)}
      onBlur={() => setPointedAt(false)}
      className={[
        "relative flex shrink-0 items-center justify-center border-2 transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        SLOT_APPEARANCE_CLASSES[
          slotAppearance({
            isOver,
            wouldTake,
            isSource,
            isOpen: isOpen === true,
            locked,
            idle,
            filled: instance != null,
          })
        ],
      ].join(" ")}
      style={{
        width: sizePx,
        height: sizePx,
        touchAction: "none",
      }}
      title={asking ? undefined : instance ? name : emptyHint}
      aria-label={
        inspected
          ? `${label}: ${inspected.card.speech}`
          : [
              `${label}: ${name}`,
              idle && !locked ? IDLE_NOTE : null,
              locked ? LOCKED_NOTE : pressHint,
            ]
              .filter(Boolean)
              .join(". ")
      }
      aria-pressed={isOpen}
    >
      {tile ? (
        <TilePreview
          tile={tile}
          tilesets={tilesets}
          size={Math.round(sizePx * SPRITE_SHARE)}
          direction={FRONT}
          still
          chrome={false}
          background={null}
        />
      ) : spilledTile ? (
        <span aria-hidden className="opacity-30">
          <TilePreview
            tile={spilledTile}
            tilesets={tilesets}
            size={Math.round(sizePx * SPRITE_SHARE)}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        </span>
      ) : EmptyIcon ? (
        <EmptyIcon
          size={Math.round(sizePx * EMPTY_ICON_SHARE)}
          stroke={EMPTY_ICON_STROKE}
          className="text-paper/25"
        />
      ) : null}
      {tally ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 bottom-0 px-0.5 text-[10px] leading-none font-bold text-paper [text-shadow:1px_1px_0_var(--color-ink),-1px_1px_0_var(--color-ink),1px_-1px_0_var(--color-ink),-1px_-1px_0_var(--color-ink)]"
        >
          {tally}
        </span>
      ) : null}
    </button>
  );

  return (
    <Tooltip
      content={
        inspected ? (
          <ItemCard card={inspected.card} tile={inspected.tile} tilesets={tilesets} />
        ) : null
      }
      side="top"
      open={showTooltip}
      className="pointer-events-none"
    >
      {square}
    </Tooltip>
  );
}
