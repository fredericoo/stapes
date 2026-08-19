import { getStack, replaceStack } from "../lib/mapData";
import { resolveContainer, resolveWeapon } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { reachableItemDefAt, type Actor, type ObjectRef } from "./affordances";
import { type Equipment, handAccepts } from "./equipment";

/**
 * Moving one carried thing from where it is to somewhere else.
 *
 * **Nothing here touches the board's population.** A move takes an instance out
 * of one slot and puts it in another; the number of things in the world before
 * and after is the same. That is the line this module draws against `pickUp`
 * and `drop`, which cross it in either direction — a placement becoming an
 * instance, or the reverse — and carry the world-shaped validation that goes
 * with it.
 *
 * It follows that equipping, unequipping, looting a chest and stashing something
 * into one are all the *same* operation read four ways, which is why they are one
 * function rather than four near-identical ones. A ground container's slots are
 * reachable from here because its contents are slots like any other; what makes
 * them different is only that reading or writing one rewrites a placement, and
 * that reach has to be re-asked every time.
 *
 * Pure, and shared by both ends of the wire on the same terms `./affordances`
 * is: the client asks whether a drag would land before it draws the target lit,
 * and the server asks the same question again before it honours the message. The
 * client cannot offer a move the server will refuse, because it is the same
 * question.
 */

/**
 * One slot an item can be in, on a body or in a box on the floor.
 *
 * **Addressed by index, never by instance id.** A client naming an id would be
 * naming a thing the server has to go looking for; an index is checked against a
 * container whose size the server already knows. Ids exist for tracing, not for
 * addressing.
 *
 * The index means "which one" at the *source* end only. Slots fill in order and
 * cannot be reordered, so a destination always appends and its index is ignored
 * — there is nowhere else for a thing to land.
 */
export type SlotRef =
  /** In hand — what you swing. */
  | { kind: "weapon" }
  /**
   * The other hand — a torch, a shield, anything you carry rather than swing.
   *
   * A slot of its own rather than a second weapon slot, because what reaches a
   * fight from here is light and defence and never a blow. See
   * `./equipment`'s `offhand` for why it exists at all.
   */
  | { kind: "offhand" }
  /**
   * On your back — the bag itself, not a place inside it.
   *
   * It needs a name of its own because the bag is a thing you can *move*: taking
   * it off is dragging it out of its slot, exactly as with anything else. Under
   * the moving rules nothing may go *into* it — a container may not hold a
   * container, and it is not a weapon — so it is a source and never a
   * destination, until `drop` gives it the floor.
   */
  | { kind: "bag" }
  /**
   * A position inside a container you are carrying.
   *
   * `of` names which one, and **absent means the bag on your back** — the
   * overwhelmingly common case, and every slot reference written before a hand
   * could hold a pack. Both hands take anything you can carry now, a spare
   * backpack included, and a bag held in one is a bag you can look into: this is
   * the one arm that had to learn there is more than one container on a body.
   *
   * Not a second arm beside `contents`, because it is not a second thing: a
   * position inside a container is a position inside a container, and two arms
   * would be the same capacity check, the same nesting rule and the same
   * append written twice.
   */
  | { kind: "contents"; index: number; of?: "weapon" | "offhand" }
  | { kind: "ground"; ref: ObjectRef; index: number };

/**
 * A container without a slot in it — what a panel is showing.
 *
 * The bag on your back and the chest at your feet are the same panel with this
 * as the difference, which is what stops the two views drifting apart in the
 * places a player would notice.
 */
export type ContainerRef =
  | { kind: "bag" }
  /** A container held in one of your hands, rather than worn. */
  | { kind: "hand"; hand: "weapon" | "offhand" }
  | { kind: "ground"; ref: ObjectRef };

/**
 * A container on the floor that somebody has open, and where it is.
 *
 * The two travel together rather than being held apart, because they are one
 * answer: a panel that had the contents but not the reference could show what is
 * in a chest without being able to name a slot in it, and one that had the
 * reference but not the contents would have to go looking for them. The contents
 * are read fresh off the board every frame — they ride on the placement — so
 * nothing here is a copy that can go stale.
 */
export type OpenedContainer = { instance: ItemInstance; ref: ObjectRef };

/** The slot at a position in a container being looked into. */
export function slotIn(container: ContainerRef, index: number): SlotRef {
  if (container.kind === "bag") return { kind: "contents", index };
  if (container.kind === "hand") {
    return { kind: "contents", index, of: container.hand };
  }
  return { kind: "ground", ref: container.ref, index };
}

/**
 * Which slot on the body holds the container a `contents` reference is inside.
 *
 * One place, because "absent means the bag" is a default and a default written
 * out at six call sites is six chances to forget it.
 */
function contentsHolder(slot: {
  of?: "weapon" | "offhand";
}): "bag" | "weapon" | "offhand" {
  return slot.of ?? "bag";
}

/**
 * A stable string for a slot, for anything keying a collection by one.
 *
 * Only ever compared against another key from this same function — it is an
 * identity for a UI to hold, never something that crosses the wire.
 */
export function slotKey(slot: SlotRef): string {
  if (slot.kind === "weapon") return "weapon";
  if (slot.kind === "offhand") return "offhand";
  if (slot.kind === "bag") return "bag";
  if (slot.kind === "contents") {
    return `contents:${contentsHolder(slot)}:${slot.index}`;
  }
  const { x, y, z, stackIndex } = slot.ref;
  return `ground:${x},${y},${z},${stackIndex}:${slot.index}`;
}

/** Are these two slots in the same container, or the same single slot? */
function sameContainer(a: SlotRef, b: SlotRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "contents" && b.kind === "contents") {
    return contentsHolder(a) === contentsHolder(b);
  }
  if (a.kind !== "ground" || b.kind !== "ground") return true;
  return (
    a.ref.x === b.ref.x &&
    a.ref.y === b.ref.y &&
    a.ref.z === b.ref.z &&
    a.ref.stackIndex === b.ref.stackIndex
  );
}

/** How many things fit in this instance, or 0 when it is not a container. */
function capacityOf(
  instance: ItemInstance,
  tilesById: Record<string, TileDef>,
): number {
  const def = tilesById[instance.tileId];
  return def ? (resolveContainer(def)?.size ?? 0) : 0;
}

/**
 * The container placement at a slot's cell, if the actor can reach into it.
 *
 * Re-asked on every call rather than trusted from whatever produced the
 * reference, because the panel that produced it may have been open while its
 * owner walked away — and on the server it arrived from a browser that can say
 * anything at all.
 */
function groundContainerAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): PlacedTile | null {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  if (!def || !resolveContainer(def)) return null;
  return getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex] ?? null;
}

/** Which kind of place a slot is, with the position dropped. */
export type SlotKind = SlotRef["kind"];

/**
 * May this kind of slot hold this thing at all?
 *
 * **The one place the nesting rule lives**, which is what every direction a move
 * can take goes through: bag → ground, ground → bag, and ground → another chest
 * all ask this same question, so there is no direction left over for a container
 * to sneak into another one through. `./decay` asks it too, because a thing that
 * rots into something else in your bag is arriving in that slot as surely as one
 * you dragged there.
 *
 * The weapon slot's rule is here for the same reason — it is the other half of
 * "what may go where", and a hand holding a signpost would be a state the model
 * allows and nothing else in the game has an answer for.
 *
 * Takes the kind rather than the slot because the position never mattered: what
 * a slot accepts is a fact about the *kind* of place it is, and a caller with no
 * index to offer should not have to invent one to ask.
 */
export function slotAccepts(
  kind: SlotKind,
  instance: ItemInstance,
  tilesById: Record<string, TileDef>,
): boolean {
  const def = tilesById[instance.tileId];
  if (!def) return false;
  // Both hands, one rule, and it is a generous one — see `handAccepts`. A drag
  // is somebody saying exactly what they want, and a hand refusing a thing you
  // could obviously hold is the interface arguing with them. Which slot a thing
  // *belongs* in is `equipSlotOf`'s question, asked only when nobody has said.
  if (kind === "weapon" || kind === "offhand") return handAccepts(def);
  // The one slot a container may go in besides a hand, and only a wearable one.
  if (kind === "bag") return resolveContainer(def)?.equippable === true;
  // Inside a bag, where the nesting rule still bites: a pack in a pack is the
  // one arrangement nothing in the model has an answer for.
  return resolveContainer(def) == null;
}

/**
 * What is in a slot right now, or null when it is empty or unreachable.
 *
 * Exported because `drop` needs the same answer: a thing leaving for the floor
 * comes out of a slot exactly as a thing moving between slots does, and reading
 * one two ways is how the two rules would come to disagree about what a slot
 * holds.
 */
export function itemInSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
): ItemInstance | null {
  if (slot.kind === "weapon") return equipment.weapon;
  if (slot.kind === "offhand") return equipment.offhand;
  if (slot.kind === "bag") return equipment.bag;
  if (slot.kind === "contents") {
    return equipment[contentsHolder(slot)]?.contents?.[slot.index] ?? null;
  }
  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  return placed?.contents?.[slot.index] ?? null;
}

/**
 * Is there room here for this thing, once it may go here at all?
 *
 * Asked against the state *before* the source is emptied, which is sound only
 * because a move within one container is refused outright — see
 * {@link applyItemMove}. Two different containers cannot free each other's room.
 */
function slotHasRoom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
): boolean {
  if (slot.kind === "weapon") return equipment.weapon === null;
  if (slot.kind === "offhand") return equipment.offhand === null;
  if (slot.kind === "bag") return equipment.bag === null;
  if (slot.kind === "contents") {
    const holder = equipment[contentsHolder(slot)];
    if (!holder) return false;
    return (holder.contents?.length ?? 0) < capacityOf(holder, tilesById);
  }
  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  if (!placed) return false;
  const def = tilesById[placed.tileId];
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  return (placed.contents?.length ?? 0) < size;
}

/** Rewrite a ground container's contents, leaving the rest of its slot alone. */
function withGroundContents(
  map: MapFile,
  ref: ObjectRef,
  contents: ItemInstance[],
): MapFile {
  const stack = getStack(map, ref.x, ref.y, ref.z);
  const next = stack.map((placed, i) =>
    i === ref.stackIndex ? { ...placed, contents } : placed,
  );
  return replaceStack(map, ref.x, ref.y, ref.z, next);
}

/**
 * Append one thing to the container at a slot, or null when nothing is there.
 *
 * The one write `GameSession.drop` needs when a thing thrown at a box lands
 * inside it, and it goes through the same {@link withGroundContents} a move into
 * that slot does — writing a placement's contents a second way is how two paths
 * come to disagree about what a container holds.
 *
 * No reach test, unlike every slot here: a drop is a throw and its range is
 * `canDropAt`'s, which is much longer than an arm's. The caller has already
 * asked, through `dropDestinationAt`, which is what named this slot.
 */
export function stashInContainer(
  map: MapFile,
  ref: ObjectRef,
  instance: ItemInstance,
): MapFile | null {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return null;
  return withGroundContents(map, ref, [...(placed.contents ?? []), instance]);
}

/** The board and the kit after a move. Whichever half did not change is `===`. */
export type ItemMoveResult = { map: MapFile; equipment: Equipment };

/**
 * Move a thing from one slot to another, or refuse.
 *
 * Null for every refusal rather than a reason, because there is nothing to say:
 * the client never offers an illegal move — it asks this same question to decide
 * whether to light the target at all — so a refusal here is either a race with
 * the board or a client that made it up, and neither wants a message.
 *
 * A move *within* one container is refused. There is no reordering: slots fill
 * in order and position in a bag means nothing, so a drag from one of its
 * squares to another is asking for something the model does not have.
 */
export function applyItemMove(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  from: SlotRef,
  to: SlotRef,
): ItemMoveResult | null {
  if (sameContainer(from, to)) return null;

  const instance = itemInSlot(map, tilesById, actor, equipment, from);
  if (!instance) return null;
  // The same refusal `pickUp` makes, for the same reason and one slot further
  // in: an anonymous instance means something skipped the minting pass, and a
  // move that honoured it would put a thing the protocol cannot describe into a
  // kit — which does not fail here, it fails on the socket, as a message the
  // owner's own client throws away.
  if (!instance.id) return null;
  if (!slotAccepts(to.kind, instance, tilesById)) return null;
  if (!slotHasRoom(map, tilesById, actor, equipment, to)) return null;

  const emptied = clearSlot(map, tilesById, actor, equipment, from);
  if (!emptied) return null;
  return fillSlot(
    emptied.map,
    tilesById,
    actor,
    emptied.equipment,
    to,
    instance,
  );
}

/** Whether a move would be honoured, without working out what it leaves behind. */
export function canMoveItem(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  from: SlotRef,
  to: SlotRef,
): boolean {
  return applyItemMove(map, tilesById, actor, equipment, from, to) != null;
}

/**
 * Take whatever is at a slot out of it. Null when there was nothing to take.
 *
 * Shared with `drop` for the reason {@link itemInSlot} is: emptying a slot is
 * emptying a slot, whether what comes out lands in another one or on the floor.
 */
export function clearSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
): ItemMoveResult | null {
  if (slot.kind === "weapon") {
    if (!equipment.weapon) return null;
    return { map, equipment: { ...equipment, weapon: null } };
  }

  if (slot.kind === "offhand") {
    if (!equipment.offhand) return null;
    return { map, equipment: { ...equipment, offhand: null } };
  }

  if (slot.kind === "bag") {
    if (!equipment.bag) return null;
    return { map, equipment: { ...equipment, bag: null } };
  }

  if (slot.kind === "contents") {
    const where = contentsHolder(slot);
    const holder = equipment[where];
    const contents = holder?.contents;
    if (!holder || !contents?.[slot.index]) return null;
    return {
      map,
      equipment: {
        ...equipment,
        [where]: { ...holder, contents: removeAt(contents, slot.index) },
      },
    };
  }

  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  const contents = placed?.contents;
  if (!contents?.[slot.index]) return null;
  return {
    map: withGroundContents(map, slot.ref, removeAt(contents, slot.index)),
    equipment,
  };
}

/**
 * Put a thing in a slot, appending for a container.
 *
 * Appends rather than writing at an index, which is what keeps `contents` a list
 * with no holes in it: there is no reordering, so a thing goes on the end and
 * the only question a slot index ever answers is which one to take.
 */
function fillSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
  instance: ItemInstance,
): ItemMoveResult | null {
  if (slot.kind === "weapon") {
    return { map, equipment: { ...equipment, weapon: instance } };
  }

  if (slot.kind === "offhand") {
    return { map, equipment: { ...equipment, offhand: instance } };
  }

  if (slot.kind === "bag") {
    return { map, equipment: { ...equipment, bag: instance } };
  }

  if (slot.kind === "contents") {
    const where = contentsHolder(slot);
    const holder = equipment[where];
    if (!holder) return null;
    return {
      map,
      equipment: {
        ...equipment,
        [where]: { ...holder, contents: [...(holder.contents ?? []), instance] },
      },
    };
  }

  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  if (!placed) return null;
  return {
    map: withGroundContents(map, slot.ref, [...(placed.contents ?? []), instance]),
    equipment,
  };
}

/** A copy with one entry gone, so the list stays holeless. */
function removeAt(contents: ItemInstance[], index: number): ItemInstance[] {
  return contents.filter((_, i) => i !== index);
}
