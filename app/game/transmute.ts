import type { Transmutation } from "../lib/interactions";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import {
  reachableTransmuteAt,
  type Actor,
  type ObjectRef,
} from "./affordances";
import type { Equipment, EquipSlot } from "./equipment";
import {
  capacityOf,
  clearSlot,
  slotTakes,
  type SlotKind,
  type SlotRef,
} from "./itemMoves";

/**
 * Spending one carried thing at something that turns it into others.
 *
 * **The board is not touched, and that is the whole shape.** Nothing is taken
 * off the map, nothing swaps, no cell patch goes out — the fire is still a fire
 * and still cooks for the next person, exactly as an emptied chest is still a
 * chest. What changes is the kit of whoever pressed it, so every rule here is a
 * rule about a kit and this module never returns a map.
 *
 * **What comes back goes where the payment came from, and overflows onto the
 * body.** The hand that held out the meat takes the steak; a thing spent out of
 * a pack comes back into that pack. Anything that will not fit there spills to
 * whatever else the player is wearing — never onto the floor, and never anywhere
 * they have to go looking for it. When the body has no room left at all the
 * recipe is not offered. See {@link landingsFor}.
 *
 * The half that decides *whether* it can happen is here rather than in
 * `./affordances` because it needs an actor's own equipment, which the board's
 * questions deliberately know nothing about. `reachableTransmuteAt` is the
 * board's half and this joins it to the kit — the same division `canRewardFrom`
 * makes, one module further out because a slot search is not a board question.
 *
 * Pure, and read by both ends: the client to decide whether to offer the row,
 * the server to validate the message it is sent. Being the same function is
 * what stops the client offering a recipe the server would refuse.
 */

/**
 * A recipe about to be run: what will be spent, and the kit left behind once it
 * has been.
 *
 * The kit is carried rather than recomputed by the caller because the *order*
 * matters and is easy to get backwards: the input leaves before the outputs
 * arrive, so the slot it vacated is genuinely room the outputs may use. A caller
 * that asked "does this fit" against the kit as it stands now would refuse to
 * cook the last steak in a full bag, which is precisely the moment somebody
 * wants to.
 */
/**
 * The slots a recipe may be paid out of.
 *
 * Derived from {@link SlotRef} rather than restated, so the arms cannot drift
 * from the ones the move rules know about. It is narrower than a `SlotRef` in
 * two deliberate ways — no `bag`, because a pack is not a thing you spend, and
 * no `ground`, because reaching into a chest at your feet is a different act
 * from offering what you carry — and being narrower is what lets the return
 * path know there is a container to put things back into.
 */
export type PaidFrom = Extract<
  SlotRef,
  { kind: "weapon" | "offhand" | "contents" }
>;

export type TransmutePlan = {
  recipe: Transmutation;
  /**
   * Where the spent thing was — and therefore where everything it becomes goes.
   *
   * One slot for both halves of the swap wherever it can be: a recipe puts its
   * results back where it took its payment from, and only overflows elsewhere
   * on the body. See {@link landingsFor}.
   */
  from: PaidFrom;
  /** The kit with the input gone and nothing yet put back. */
  spent: Equipment;
  /**
   * Where each thing that comes back ends up, in the order the author wrote
   * them.
   *
   * Decided while the recipe is being *allowed* rather than while it is being
   * run, because the two questions are the same one: "is there room" is
   * answered by finding somewhere for every last thing, and having found it
   * there is nothing left to decide. A run that worked it out again could work
   * it out differently from the check that offered the row.
   */
  landings: Landing[];
};

/**
 * A place on the body a result can land.
 *
 * Deliberately not a {@link SlotRef}: a container destination has no index,
 * because slots fill in order and a thing arriving in a pack goes on the end —
 * the same reason a `SlotRef` used as a move's *destination* has its index
 * ignored. Naming a position here would be inventing one nobody reads.
 */
export type Landing =
  | { kind: "hand"; hand: "weapon" | "offhand"; tileId: string }
  | { kind: "container"; holder: EquipSlot; tileId: string };

/**
 * What running this recipe would leave, or null when it cannot be run.
 *
 * Every refusal is null and none of them is distinguished, on exactly the terms
 * a reward's are: out of reach, nothing to spend, no room for what comes back,
 * or a recipe naming tiles that do not exist. Whichever it is there is no row
 * and no outline, so a fire you have nothing to cook at reads as a fire rather
 * than as something withholding.
 */
export function planTransmute(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  index: number,
): TransmutePlan | null {
  const transmute = reachableTransmuteAt(map, tilesById, actor, ref);
  const recipe = transmute?.recipes[index];
  if (!recipe) return null;

  // Never a container, and this is the one refusal that is about the *input*
  // rather than about reach or room. A pack is not a thing you spend: a hand
  // can hold one, so without this a recipe naming a bag would take it off you
  // with everything inside it — a whole inventory destroyed by a row that said
  // "Trade Backpack". The same line `itemsFitInBag` draws on the way back in,
  // and for a related reason: what a container holds is not the container.
  const inputDef = tilesById[recipe.fromTileId];
  if (!inputDef || resolveContainer(inputDef)) return null;

  const from = carriedSlotOf(equipment, recipe.fromTileId);
  if (!from) return null;

  // Through the same emptier a move and a drop use, so there is one answer to
  // "what does taking a thing out of a slot leave behind". Only kit slots are
  // ever searched, so the map it hands back is the one it was given — this is
  // asserted by the shape rather than by a check: nothing here reads it.
  const spent = clearSlot(map, tilesById, actor, equipment, from);
  if (!spent) return null;

  // All or nothing, and asked *after* the input has gone. Finding somewhere for
  // every last thing *is* the room check — see {@link landingsFor}.
  const landings = landingsFor(
    tilesById,
    spent.equipment,
    from,
    recipe.toTileIds,
  );
  if (!landings) return null;

  return { recipe, from, spent: spent.equipment, landings };
}

/**
 * Somewhere on the body for every last thing this recipe gives back, or null
 * when there is not.
 *
 * **The room check and the placement are one question.** Whether a recipe may
 * run is exactly whether every result has somewhere to go, so finding those
 * places is the answer rather than a step after it — and the row that gets
 * offered is the row that will do what this worked out.
 *
 * **Nothing ever lands on the floor.** A result the body cannot hold does not
 * get dropped at the player's feet; the recipe is simply not offered, so a
 * player never presses a row and then goes looking for what it did to their
 * kit. Denying is the only alternative to spilling, and spilling somewhere they
 * are wearing is the one that loses nothing.
 *
 * Asked against the kit with the input already gone, which is what makes the
 * ordinary case free: the square the payment vacated is the square its result
 * lands in. Cooking the last steak in a full pack needs no room, and neither
 * does cooking one held in a hand while the pack is full — and that second case
 * is not a corner, because a pickup reaches for a hand only once the pack has
 * none, so "input in a hand" and "bag full" are the same moment.
 *
 * First fit down {@link returnSlots}, rather than anything cleverer. The
 * destinations are only two kinds and a hand takes strictly more than a pack
 * does, so working down the list in order places everything a smarter search
 * would in every arrangement this game can produce — and where it does refuse,
 * it refuses, which is the safe direction.
 */
function landingsFor(
  tilesById: Record<string, TileDef>,
  spent: Equipment,
  from: PaidFrom,
  toTileIds: readonly string[],
): Landing[] | null {
  const room = returnSlots(tilesById, spent, from);
  const landings: Landing[] = [];

  for (const tileId of toTileIds) {
    const def = tilesById[tileId];
    if (!def) return null;
    // The same rule a drag into that slot asks, so anything a recipe hands back
    // is something the player could have put there themselves.
    const found = room.find(
      (place) => place.free > 0 && slotTakes(place.slotKind, def),
    );
    if (!found) return null;
    found.free--;
    landings.push(found.landing(tileId));
  }

  return landings;
}

/** A destination with its remaining room, for {@link landingsFor} to spend. */
type ReturnSlot = {
  slotKind: SlotKind;
  free: number;
  landing: (tileId: string) => Landing;
};

/**
 * Everywhere on this body a result may land, best first.
 *
 * **The slot that paid comes first**, which is the whole of "a trade puts it
 * back where you held it out" — and it is what makes a one-for-one swap free of
 * any other room.
 *
 * Then the pack, then the hands, which is `pickUpDestination`'s order and for
 * its reasons: a thing you are merely carrying belongs in the bag, and a hand
 * is where something goes when there is nowhere else. The off hand before the
 * weapon hand, because what you swing with is the slot with consequences.
 *
 * A hand already holding something is not offered at all. Overflow may fill a
 * hand you have free; it may never put down what is in one.
 */
function returnSlots(
  tilesById: Record<string, TileDef>,
  spent: Equipment,
  from: PaidFrom,
): ReturnSlot[] {
  const out: ReturnSlot[] = [];
  const paidFromHand = from.kind === "weapon" || from.kind === "offhand";
  const paidFromHolder = paidFromHand ? null : (from.of ?? "bag");

  if (paidFromHand) out.push(handSlot(from.kind as "weapon" | "offhand"));
  else if (paidFromHolder) {
    out.push(...containerSlot(tilesById, spent, paidFromHolder));
  }

  if (paidFromHolder !== "bag") {
    out.push(...containerSlot(tilesById, spent, "bag"));
  }

  for (const hand of ["offhand", "weapon"] as const) {
    if (paidFromHand && from.kind === hand) continue;
    if (spent[hand]) continue;
    out.push(handSlot(hand));
  }

  return out;
}

/** An empty hand: one thing, and the mechanism knows which hand it was. */
function handSlot(hand: "weapon" | "offhand"): ReturnSlot {
  return {
    slotKind: hand,
    free: 1,
    landing: (tileId) => ({ kind: "hand", hand, tileId }),
  };
}

/** A container on the body with squares to spare, or nothing when it has none. */
function containerSlot(
  tilesById: Record<string, TileDef>,
  spent: Equipment,
  holder: EquipSlot,
): ReturnSlot[] {
  const instance = spent[holder];
  if (!instance) return [];
  const free = capacityOf(instance, tilesById) - (instance.contents?.length ?? 0);
  if (free <= 0) return [];
  return [
    {
      slotKind: "contents",
      free,
      landing: (tileId) => ({ kind: "container", holder, tileId }),
    },
  ];
}

/** Could this actor run this recipe right now? @see planTransmute */
export function canTransmuteFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  index: number,
): boolean {
  return planTransmute(map, tilesById, actor, equipment, ref, index) != null;
}

/**
 * Every recipe this placement offers that the actor could actually run, with
 * the index each was authored at.
 *
 * The index travels because it is how a recipe is *addressed* — the row the
 * player presses names one of several on the same tile, and both ends read the
 * same authored list, so a position is enough and a name would be a second
 * thing to keep unique. The same reasoning `SlotRef` gives for indexing rather
 * than naming instances.
 *
 * Only the runnable ones, so the list never offers a recipe for something the
 * player is not carrying. A fire's menu is what you could cook, not what fires
 * can do.
 */
export function offeredTransmutations(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
): { index: number; recipe: Transmutation }[] {
  const transmute = reachableTransmuteAt(map, tilesById, actor, ref);
  if (!transmute) return [];

  const out: { index: number; recipe: Transmutation }[] = [];
  for (let index = 0; index < transmute.recipes.length; index++) {
    const plan = planTransmute(map, tilesById, actor, equipment, ref, index);
    if (plan) out.push({ index, recipe: plan.recipe });
  }
  return out;
}

/**
 * The kit after a recipe has been run, with the outputs minted into the bag.
 *
 * Every output is a **fresh identity**, on exactly the terms a reward's items
 * are: a recipe is a recipe and not an object changing hands, so two people who
 * cook at the same fire come away with two distinct steaks.
 *
 * Takes the minting function rather than calling `mintItemId` itself so that
 * asking whether a recipe *could* run costs no identities — see
 * {@link canTransmuteFrom}, which stops at the plan.
 */
export function runTransmute(
  plan: TransmutePlan,
  mintId: () => string,
): Equipment {
  // Nothing is decided here — {@link landingsFor} already found somewhere for
  // every one of these, and it did so against this same kit. All that is left
  // is to give each of them an identity and put it there.
  return plan.landings.reduce<Equipment>((kit, landing) => {
    const instance: ItemInstance = { id: mintId(), tileId: landing.tileId };
    if (landing.kind === "hand") {
      return { ...kit, [landing.hand]: instance };
    }
    // Appending, exactly as `itemMoves`' `fillSlot` does for a container
    // destination — slots fill in order, so a thing arriving goes on the end.
    // Written here rather than shared because that one takes a map and a
    // location to reach a chest on the floor, and this module never holds
    // either: a recipe only ever fills the body.
    const holder = kit[landing.holder]!;
    return {
      ...kit,
      [landing.holder]: {
        ...holder,
        contents: [...(holder.contents ?? []), instance],
      },
    };
  }, plan.spent);
}

/**
 * Where on this body the first thing of this kind is, or null for somebody not
 * carrying one.
 *
 * **Hands before the bag**, which is the order a person offers something in:
 * what you are already holding out is what you meant, and a recipe that reached
 * past it into the pack would leave you standing there with the steak still in
 * your fist. Within the bag it is the first square, because slots have no
 * meaning beyond their order and two steaks are two steaks.
 *
 * The order pairs with {@link returnFits}, and the pairing is what makes a full
 * pack workable: a pickup reaches for a hand only once the bag has no room, so
 * the hand is where the input is at exactly the moment the bag could not have
 * held the output — and the hand that paid is what takes it back.
 *
 * Bag *contents* and never the bag itself: a pack is not a thing you spend, and
 * a recipe naming one would otherwise take the pack off your back along with
 * everything in it.
 *
 * Containers held in a hand are not searched either, and that is the one
 * deliberate gap. Rummaging in a bag you happen to be holding is a different
 * act from offering what you carry, and a recipe that quietly emptied one would
 * be reaching somewhere the player did not point.
 */
function carriedSlotOf(
  equipment: Equipment,
  tileId: string,
): PaidFrom | null {
  if (equipment.weapon?.tileId === tileId) return { kind: "weapon" };
  if (equipment.offhand?.tileId === tileId) return { kind: "offhand" };

  const contents = equipment.bag?.contents ?? [];
  const index = contents.findIndex((item) => item.tileId === tileId);
  return index === -1 ? null : { kind: "contents", index };
}
