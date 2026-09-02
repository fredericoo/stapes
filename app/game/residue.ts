import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import type { Actor } from "./affordances";
import type { Equipment } from "./equipment";
import {
  placeInSlot,
  slotKey,
  type ItemMoveResult,
  type SlotRef,
} from "./itemMoves";

/**
 * Where what a drink leaves behind goes.
 *
 * A potion is two things and consuming it spends one of them — see
 * `../lib/item`'s `ConsumableItem.leaves`. This module answers the one question
 * that raises: the glass has to go *somewhere*, and the somewhere is decided on
 * a recipe's terms rather than a pickup's. **Nothing ever reaches the floor.** A
 * bottle the body cannot hold does not get dropped at the drinker's feet; the
 * drink is refused, so a player never swallows something and then goes looking
 * for what it did to their kit.
 *
 * Kept out of `./itemMoves`, which knows how to put a thing in a slot and
 * deliberately not which slots to try, and out of `./transmute`, whose order
 * this borrows but whose destinations are typed for a recipe's `PaidFrom` — a
 * drink can come out of a chest on the floor, which a recipe never does.
 */

/**
 * Everywhere the residue may land, best first.
 *
 * **The place the drink was comes first**, which is the whole of "the bottle is
 * in the hand that held the potion": a potion drunk out of a bag leaves its
 * bottle in that bag, out of a chest leaves it in the chest, out of a hand
 * leaves it in that hand. Then the worn bag, then the hands, which is
 * `pickUpDestination`'s order and for its reasons — off hand before weapon hand,
 * because what you swing with is the slot with consequences.
 *
 * Any of these may refuse: a hand still holding the rest of the pile, a bag with
 * no square and no bottle pile to pour into. `placeInSlot` asks, and a refusal
 * simply moves on to the next. The list is deduplicated by key so a drink out
 * of the worn bag does not ask it twice.
 */
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

/**
 * The slot the drink came out of, as a destination.
 *
 * A container destination's index is ignored — a thing arriving goes on the end
 * — so it is written as zero rather than carried over from the source. See
 * `./itemMoves`' `fillSlot`.
 */
function sameContainerAs(from: SlotRef): SlotRef {
  if (from.kind === "contents") {
    return { kind: "contents", index: 0, ...(from.of ? { of: from.of } : {}) };
  }
  if (from.kind === "ground") return { kind: "ground", ref: from.ref, index: 0 };
  return { kind: from.kind };
}

/**
 * The board and kit with the residue somewhere on the body, or null when there
 * is nowhere for it.
 *
 * Asked against the state with the drink already gone — the caller passes what
 * `peelSlot` returned — which is what makes the ordinary case free: the square
 * the last potion vacated is the square its bottle lands in, and a bottle
 * pouring onto a bottle pile needs no square at all.
 */
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
