import { resolveContainer, resolveWeapon } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import type { SlotRef } from "./itemMoves";

/**
 * What tapping a thing does to it.
 *
 * **A tap uses an item; it never moves one.** Moving is a drag, from one square
 * to another, and it is the only thing a drag does — so the press that is left
 * over is free to mean the interesting thing. That matters more than it looks:
 * the items this game is heading for are drunk, eaten and read, and an interface
 * that had spent its single most obvious gesture on "pick this up a bit" would
 * have to invent a worse one for them.
 *
 * So the question here is not "where would this go" but "what is this *for*",
 * and every kind of item answers it in its own terms:
 *
 * - a container is for looking inside, so a tap opens it;
 * - a weapon is for holding, so a tap puts it in your hand — and taps the one in
 *   your hand back into your bag, because the inverse of a use is the same
 *   gesture again.
 *
 * A future consumable answers it by being drunk. Nothing here has to change for
 * that; it gains a case.
 *
 * Pure and separate from the panels, because the answer belongs to the item
 * rather than to the square it happens to be sitting in — and because the two
 * places that will need it (a tap, and eventually a row in the interaction list)
 * must not each have their own idea of what using a thing means.
 */

export type ItemUse =
  /** Look inside it. Panel state, and no business of the board's. */
  | { type: "open" }
  /**
   * Put it somewhere, in the terms every other move is expressed in.
   *
   * Deliberately not a use of its own: wielding a sword is `moveItem` and
   * nothing else, so it is validated once, by the rules that already say what a
   * slot will take. A refused move is a tap that does nothing — which is the
   * honest outcome when your hand is already full, since the model has no swap
   * and inventing one here would be inventing it in the wrong place.
   */
  | { type: "move"; to: SlotRef };

/**
 * Where a weapon goes when it is put away.
 *
 * Index zero rather than a search for a free square, because a container
 * destination appends: slots fill in order and the index at the far end of a
 * move is ignored. See `./itemMoves`.
 */
const FIRST_BAG_SLOT: SlotRef = { kind: "contents", index: 0 };

/** What a tap on this thing, in this square, would do — or nothing. */
export function itemUseFor(
  instance: ItemInstance,
  slot: SlotRef,
  tilesById: Record<string, TileDef>,
): ItemUse | null {
  const def = tilesById[instance.tileId];
  if (!def) return null;

  if (resolveWeapon(def)) {
    return slot.kind === "weapon"
      ? { type: "move", to: FIRST_BAG_SLOT }
      : { type: "move", to: { kind: "weapon" } };
  }

  // Only the bag on your back, and that is not a special case — no container may
  // hold a container, so the bag slot is the one square in the game a container
  // can be sitting in. A chest is opened where it lies, from the world.
  if (resolveContainer(def)) return slot.kind === "bag" ? { type: "open" } : null;

  return null;
}
