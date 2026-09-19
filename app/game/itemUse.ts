import { resolveConsumable, resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { equipSlotsFor, type ObjectRef } from "./affordances";
import type { Equipment } from "./equipment";
import { equipDestination, isBodySlot, type SlotRef } from "./itemMoves";

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
 * - a weapon is for holding and armour is for wearing, so a tap puts either in
 *   the best square it belongs in — the same ranking a drop on the equipment
 *   button gets, so a free square is always filled before a full one is traded
 *   out — and taps the thing already equipped back into your bag, because the
 *   inverse of a use is the same gesture again;
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
   * slot will take. It follows that a tap trades with a full square rather than
   * doing nothing, because that is what a move onto one does now — see
   * `./itemMoves`' `swapInto`. A refused move is still a tap that does nothing,
   * and it is still the honest outcome: there is nothing to say about a square
   * the rules will not have.
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

/**
 * What a tap on this thing, in this square, would do — or nothing.
 *
 * **The kit is an argument because where a thing goes depends on what is
 * already on you.** Tapping a second sword used to put it where the first one
 * was, because the answer was read off the tile alone and a tile knows one
 * square; arming yourself out of a full bag meant a row of taps that each threw
 * away the one before. It is {@link equipDestination} now — the same ranking a
 * drop on the equipment button gets — so every free square is filled before
 * anything is displaced, and the two gestures cannot come to disagree about
 * where a thing goes.
 */
export function itemUseFor(
  instance: ItemInstance,
  slot: SlotRef,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): ItemUse | null {
  const def = tilesById[instance.tileId];
  if (!def) return null;

  // A pack is for looking in, wherever on you it is, and that beats moving it:
  // the drag is how you take one off. Checked first because a container is the
  // one kind of item whose slot and whose use disagree — and it is the reason
  // both hands take one at all, since a bag you could hold but never open would
  // be a worse place to keep it than the floor.
  if (resolveContainer(def)) {
    return slot.kind === "bag" ||
      slot.kind === "weapon" ||
      slot.kind === "offhand"
      ? { type: "open" }
      : null;
  }

  // **Where the thing belongs**, which is the same answer the floor's "Wield"
  // and "Hold" rows are built from — see `./affordances`' `equipSlotsFor`. This
  // used to be guessed from whether the tile gave off light, because a lantern
  // is authored as a weapon and the swinging hand was once the only hand; the
  // guess is gone now that `WeaponItem.offhand` says it outright.
  // Every slot but the bag, which the container branch above has already
  // answered — the only things that belong on a back are containers, and looking
  // into one beats taking it off.
  const homes = equipSlotsFor(def);
  if (homes.length > 0 && homes[0] !== "bag") {
    // **Already where it belongs, so the tap takes it off.** Any of its squares,
    // not only the first: a torch in your fist is as worn as one on a belt loop,
    // and a tap that moved it between the two would leave no gesture that puts
    // it away.
    if (isBodySlot(slot) && homes.includes(slot.kind)) {
      return { type: "move", to: FIRST_BAG_SLOT };
    }
    // The square it came out of is refused rather than ranked: it is a
    // candidate like any other — a sword in your off hand belongs in the other
    // one — and a move onto the square a thing is already in is a swap with
    // itself. Nothing else is filtered, so a tap that has nowhere to go simply
    // does nothing.
    const to = equipDestination(
      equipment,
      tilesById,
      instance,
      (dest) => dest.kind !== slot.kind,
    );
    return to && to.kind !== slot.kind ? { type: "move", to } : null;
  }

  // From any slot it can be sitting in — a hand, your bag, or a box on the
  // floor. Nothing about eating depends on where the thing was.
  if (resolveConsumable(def)) return { type: "consume" };

  return null;
}
