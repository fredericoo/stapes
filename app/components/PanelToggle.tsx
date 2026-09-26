import { IconBackpack, IconHeartbeat, IconShirt } from "@tabler/icons-react";
import { useCallback, useRef } from "react";
import type { Equipment } from "../game/equipment";
import { equipDestination, type SlotRef } from "../game/itemMoves";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./actionButton";
import type { HeldItem, ItemDrag } from "./useItemDrag";
import { useTap } from "./useTap";

function toggleClass(on: boolean, size: ActionButtonSize): string {
  return [
    "flex items-center justify-center border-2 shadow-hard",
    ACTION_BUTTON_SIZE_CLASS[size],
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    on ? "border-paper bg-paper text-ink" : "border-paper/40 bg-transparent text-paper",
  ].join(" ");
}

export function StatsToggle({
  open,
  onChange,
  size = "touch",
}: {
  open: boolean;
  onChange: (open: boolean) => void;
  size?: ActionButtonSize;
}) {
  const tap = useTap(() => onChange(!open));

  return (
    <Tooltip content="Stats">
      <button
        type="button"
        aria-pressed={open}
        aria-label="Stats"
        {...tap}
        className={toggleClass(open, size)}
      >
        <IconHeartbeat size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

const EQUIPMENT_BUTTON_TARGET_KEY = "equipment-button";

export function EquipmentToggle({
  open,
  onChange,
  equipment,
  tilesById,
  drag,
  size = "touch",
}: {
  open: boolean;
  onChange: (open: boolean) => void;
  equipment: Equipment;
  tilesById: Record<string, TileDef>;
  drag: ItemDrag;
  size?: ActionButtonSize;
}) {
  const { register } = drag;
  const latest = useRef({ equipment, tilesById });
  latest.current = { equipment, tilesById };
  const destination = useCallback(
    (held: HeldItem, lands: (to: SlotRef) => boolean) =>
      equipDestination(latest.current.equipment, latest.current.tilesById, held.instance, lands),
    [],
  );
  const attach = useCallback(
    (el: HTMLElement | null) => register(EQUIPMENT_BUTTON_TARGET_KEY, destination, el),
    [register, destination],
  );

  const wouldTake = drag.targets.has(EQUIPMENT_BUTTON_TARGET_KEY);
  const isOver = drag.over === EQUIPMENT_BUTTON_TARGET_KEY;

  const tap = useTap(() => onChange(!open));

  return (
    <Tooltip content="Equipment">
      <button
        type="button"
        ref={attach}
        aria-pressed={open}
        aria-label="Equipment"
        {...tap}
        className={[
          toggleClass(open, size),
          isOver ? "border-accent bg-accent/30" : wouldTake ? "border-accent/60" : "",
        ].join(" ")}
        style={{ touchAction: "none" }}
      >
        <IconShirt size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

const BAG_BUTTON_TARGET_KEY = "bag-button";

const BAG_BUTTON_SLOT = { kind: "contents", index: 0 } as const;

export function BagButton({
  bag,
  open,
  onChange,
  tilesById,
  drag,
  size = "touch",
}: {
  bag: ItemInstance | null;
  open: boolean;
  onChange: (open: boolean) => void;
  tilesById: Record<string, TileDef>;
  drag: ItemDrag;
  size?: ActionButtonSize;
}) {
  const tile = bag ? (tilesById[bag.tileId] ?? null) : null;
  const name = tile?.name ?? "Bag";
  const held = bag?.contents?.length ?? 0;
  const capacity = tile ? (resolveContainer(tile)?.size ?? 0) : 0;

  const { register } = drag;
  const attach = useCallback(
    (el: HTMLElement | null) => register(BAG_BUTTON_TARGET_KEY, BAG_BUTTON_SLOT, el),
    [register],
  );

  const wouldTake = drag.targets.has(BAG_BUTTON_TARGET_KEY);
  const isOver = drag.over === BAG_BUTTON_TARGET_KEY;
  const fullness = bag ? `${held} of ${capacity} full` : null;

  const tap = useTap(() => onChange(!open));

  return (
    <Tooltip content={bag ? `${name} — ${held}/${capacity}` : "No bag"}>
      <button
        type="button"
        ref={attach}
        aria-pressed={open}
        aria-label={bag ? `${name}, ${fullness}` : "No bag"}
        disabled={!bag}
        {...tap}
        className={[
          "relative",
          toggleClass(open, size),
          bag ? "" : "opacity-40",
          isOver ? "border-accent bg-accent/30" : wouldTake ? "border-accent/60" : "",
        ].join(" ")}
        style={{ touchAction: "none" }}
      >
        <IconBackpack size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
        {bag ? (
          <span
            aria-hidden="true"
            className={[
              "pointer-events-none absolute -bottom-1 -right-1 border px-0.5 text-[9px] font-bold leading-tight tabular-nums",
              held >= capacity
                ? "border-paper bg-paper text-ink"
                : "border-paper/40 bg-ink text-paper/80",
            ].join(" ")}
          >
            {held}/{capacity}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
