import { resolveConsumable, resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { equipSlotsFor, type ObjectRef } from "./affordances";
import type { Equipment } from "./equipment";
import { equipDestination, isBodySlot, type SlotRef } from "./itemMoves";

export type ItemUse = { type: "open" } | { type: "consume" } | { type: "move"; to: SlotRef };

export type ConsumeSource = { kind: "slot"; slot: SlotRef } | { kind: "floor"; ref: ObjectRef };

const FIRST_BAG_SLOT: SlotRef = { kind: "contents", index: 0 };

export function itemUseFor(
  instance: ItemInstance,
  slot: SlotRef,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): ItemUse | null {
  const def = tilesById[instance.tileId];
  if (!def) return null;

  if (resolveContainer(def)) {
    return slot.kind === "bag" || slot.kind === "weapon" || slot.kind === "offhand"
      ? { type: "open" }
      : null;
  }

  const homes = equipSlotsFor(def);
  if (homes.length > 0 && homes[0] !== "bag") {
    if (isBodySlot(slot) && homes.includes(slot.kind)) {
      return { type: "move", to: FIRST_BAG_SLOT };
    }
    const to = equipDestination(equipment, tilesById, instance, (dest) => dest.kind !== slot.kind);
    return to && to.kind !== slot.kind ? { type: "move", to } : null;
  }

  if (resolveConsumable(def)) return { type: "consume" };

  return null;
}
