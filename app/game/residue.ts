import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import type { Actor } from "./affordances";
import type { Equipment } from "./equipment";
import { placeInSlot, slotKey, type ItemMoveResult, type SlotRef } from "./itemMoves";

export function residueSlots(from: SlotRef): SlotRef[] {
  const candidates: SlotRef[] = [
    sameContainerAs(from),
    { kind: "contents", index: 0 },
    { kind: "offhand" },
    { kind: "weapon" },
  ];
  const seen = new Set<string>();
  return candidates.filter((slot) => {
    const key = slotKey(slot);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameContainerAs(from: SlotRef): SlotRef {
  if (from.kind === "contents") {
    return { kind: "contents", index: 0, ...(from.of ? { of: from.of } : {}) };
  }
  if (from.kind === "ground") return { kind: "ground", ref: from.ref, index: 0 };
  return { kind: from.kind };
}

export function leaveResidue(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  from: SlotRef,
  residue: ItemInstance,
): ItemMoveResult | null {
  for (const slot of residueSlots(from)) {
    const placed = placeInSlot(map, tilesById, actor, equipment, slot, residue);
    if (placed) return placed;
  }
  return null;
}
