import { resolveConsumable, resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { equipSlotOf, type ObjectRef } from "./affordances";
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
 * - a weapon is for holding, so a tap puts it in the hand it belongs in — and
 *   taps the one in that hand back into your bag, because the inverse of a use
 *   is the same gesture again;
 * - a consumable is for eating or drinking, so a tap spends it — the case this
 *   module was written expecting to gain.
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
   * Use it up. Goes all the way to the server, because it changes hit points
   * and destroys the thing — both the board's business, neither predictable.
   */
  | { type: "consume" }
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
 * Where the thing being consumed is: a slot in somebody's kit, or a placement
 * still lying on the board.
 *
 * A union rather than a widened {@link SlotRef}, because the two are different
 * acts with different validation: a floor consume is a board action — reach,
 * cover, idleness — where a slot consume is a kit action, and a `SlotRef` with
 * a floor arm would offer every mover in the game a place nothing can be moved
 * to. This is the one shape the wire, the session and both taps share, so the
 * two ends cannot come to hold different ideas of where a cherry can be eaten
 * from.
 */
export type ConsumeSource =
  | { kind: "slot"; slot: SlotRef }
  | { kind: "floor"; ref: ObjectRef };

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

  // A pack on your back is for looking in, and that beats moving it: the drag
  // is how you take one off. Checked first because a container is the one kind
  // of item whose slot and whose use disagree.
  if (resolveContainer(def)) return slot.kind === "bag" ? { type: "open" } : null;

  // **Where the thing belongs**, which is the same answer the floor's "Wield"
  // and "Hold" rows are built from — see `./affordances`' `equipSlotOf`. This
  // used to be guessed from whether the tile gave off light, because a lantern
  // is authored as a weapon and the swinging hand was once the only hand; the
  // guess is gone now that `WeaponItem.offhand` says it outright.
  const belongs = equipSlotOf(def);
  if (belongs === "weapon" || belongs === "offhand") {
    return slot.kind === belongs
      ? { type: "move", to: FIRST_BAG_SLOT }
      : { type: "move", to: { kind: belongs } };
  }

  // From any slot it can be sitting in — a hand, your bag, or a box on the
  // floor. Nothing about eating depends on where the thing was.
  if (resolveConsumable(def)) return { type: "consume" };

  return null;
}
