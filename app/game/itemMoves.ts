import { getStack, replaceStack } from "../lib/mapData";
import type { ItemDef } from "../lib/item";
import { resolveContainer, resolveItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import {
  countOf,
  fuses,
  peelOne,
  pourInto,
  stow,
  stowFits,
  withCount,
} from "../lib/piles";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  equipSlotOf,
  reachableItemDefAt,
  type Actor,
  type ObjectRef,
} from "./affordances";
import {
  type Equipment,
  type Hand,
  handAccepts,
  handHasRoomFor,
  otherHand,
  stoneLocked,
  wornAccepts,
} from "./equipment";

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
   * A square of its own rather than a second weapon slot, and it is the *same*
   * square: both hands swing, and a body with a weapon in each takes turns
   * between them. See `./equipment`'s `HANDS`.
   */
  | { kind: "offhand" }
  /**
   * On the body — a tunic, a mail shirt, a breastplate.
   *
   * A strict square: it takes armour and nothing else, where both hands take
   * anything you can carry. See `./equipment`'s `Equipment.armor` for why the
   * slots in this game that refuse things are the worn ones.
   */
  | { kind: "armor" }
  /**
   * On the head — a cap, a helm, a crown.
   *
   * Strict on exactly the terms the body is, and strict about *which* armour on
   * top of that: a breastplate is armour and still may not go here, because the
   * armour itself names its square. See `../lib/item`'s `ArmorItem.slot`.
   */
  | { kind: "head" }
  /**
   * Round the neck or on a finger — a ring, an amulet, a charm.
   */
  | { kind: "charm" }
  /**
   * On the feet — boots, shoes, sabatons.
   */
  | { kind: "footwear" }
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

const BODY_SLOT_KINDS: ReadonlySet<string> = new Set(EQUIP_SLOTS);

/**
 * A slot that is a square on a body, rather than a place inside something.
 *
 * Exported for the panel that draws them: a list of the squares is a list of
 * these, and typing it as a bare {@link SlotRef} would let a square in a bag
 * into a row that has nowhere to put one.
 */
export type BodySlotRef = Extract<SlotRef, { kind: EquipSlot }>;

/**
 * Whether this slot is a square on a body.
 *
 * **The one distinction the five functions below actually turn on.** Every
 * square on a body holds one thing and is named; a position in a container holds
 * one of many and is numbered. Written out per square — which it was, back when
 * there were four — each of those functions grows a near-identical branch every
 * time a square is added, and there are seven squares now.
 *
 * Read off {@link EQUIP_SLOTS} rather than a list of its own, so a square added
 * to the game is a square these functions already handle. A predicate rather
 * than a boolean, because "this is one of the squares" and "so `slot.kind` may
 * index `Equipment`" are the same fact, and returning only the first would leave
 * every caller re-narrowing it by hand.
 */
export function isBodySlot(slot: SlotRef): slot is BodySlotRef {
  return BODY_SLOT_KINDS.has(slot.kind);
}

/**
 * A stable string for a slot, for anything keying a collection by one.
 *
 * Only ever compared against another key from this same function — it is an
 * identity for a UI to hold, never something that crosses the wire.
 */
export function slotKey(slot: SlotRef): string {
  if (isBodySlot(slot)) return slot.kind;
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
export function capacityOf(
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
  return def != null && slotTakes(kind, def);
}

/**
 * The same question of a *tile*, for callers with no instance to offer.
 *
 * `../game/transmute` is one: a recipe names what comes back by tile, and the
 * things do not exist until the recipe is allowed to run — so asking whether
 * they may land somewhere cannot mean minting them first.
 */
export function slotTakes(kind: SlotKind, def: TileDef): boolean {
  // Both hands, one rule, and it is a generous one — see `handAccepts`. A drag
  // is somebody saying exactly what they want, and a hand refusing a thing you
  // could obviously hold is the interface arguing with them. Which slot a thing
  // *belongs* in is `equipSlotOf`'s question, asked only when nobody has said.
  if (kind === "weapon" || kind === "offhand") return handAccepts(def);
  // The one slot a container may go in besides a hand, and only a wearable one.
  if (kind === "bag") return resolveContainer(def)?.equippable === true;
  // Inside a bag or a box, where the nesting rule still bites: a pack in a pack
  // is the one arrangement nothing in the model has an answer for.
  if (kind === "contents" || kind === "ground") {
    return resolveContainer(def) == null;
  }
  // The four squares that refuse on kind rather than on capacity, and the whole
  // reason they can: what a hand is *for* is anything, and what a chest is for
  // is armour. A sword worn as a shirt would make the square's number — the only
  // thing it contributes to a fight — a number about nothing.
  //
  // Refused for the *wrong* armour too, which is what stops a helmet from being
  // worn as boots. The armour names its own square — see `../lib/item`'s
  // `ArmorItem.slot` — and this is the one place a drag is held to it. The charm
  // is the one of the four that takes a second kind, and `wornAccepts` is where
  // that is written down rather than here.
  return wornAccepts(kind, def);
}

/** Whether this square is one of the two hands. */
function isHand(kind: SlotKind): kind is Hand {
  return kind === "weapon" || kind === "offhand";
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
  if (isBodySlot(slot)) return equipment[slot.kind];
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
  instance: ItemInstance,
): boolean {
  if (isBodySlot(slot)) {
    return bodySlotHasRoom(equipment, tilesById, slot.kind, instance);
  }
  if (slot.kind === "contents") {
    const holder = equipment[contentsHolder(slot)];
    if (!holder) return false;
    return stowFits(
      holder.contents ?? [],
      instance,
      capacityOf(holder, tilesById),
      tilesById,
    );
  }
  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  if (!placed) return false;
  const def = tilesById[placed.tileId];
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  return stowFits(placed.contents ?? [], instance, size, tilesById);
}

/**
 * Is there room in a square on a body for this thing?
 *
 * Apart from {@link slotHasRoom} because {@link equipDestination} asks it of
 * several squares at once and has no board or actor to offer: what fits in a
 * square on a body is decided by the kit alone, where what fits in a container
 * is decided by the container — and only the second needs a map to find. Two
 * readings of "is this square free" would be two things for the equipment
 * button and the square it sends to to disagree about.
 *
 * A square that is taken is still a destination for exactly one thing: a pile
 * of the same food with room for all of it. That is the one place in the game a
 * move lands on something rather than beside it, and it is not a swap — nothing
 * comes back out, because there is nothing left of what went in. See
 * `../lib/piles`.
 */
export function bodySlotHasRoom(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  kind: EquipSlot,
  instance: ItemInstance,
): boolean {
  const held = equipment[kind];
  if (held) return fuses(held, instance, tilesById);
  const def = tilesById[instance.tileId];
  return isHand(kind) && def
    ? handHasRoomFor(equipment, tilesById, kind, def)
    : true;
}

/**
 * How much a square costs to make room in, lowest first.
 *
 * **The whole of what "best fit" means**, and it is a ladder rather than a
 * special case per kind of thing, so a square added to the body or an item kind
 * added to the game is ranked by the same four rules everything else is.
 *
 * The order is what somebody dragging a thing in would give up least of. A
 * square with nothing in it costs nothing. A square holding **the same kind of
 * thing** is the next cheapest, because that is the trade the gesture almost
 * always is: a sword for a sword, a stone for a stone, a helm for a helm.
 * Failing that, what comes out should be the thing the incoming one most nearly
 * stands in for — **a weapon**, since anything you can put in a hand is
 * something to do with that hand instead of swinging it, and swinging is what
 * you still have another hand for. **Something else held** — a shield, a torch,
 * a pack — goes only when no weapon is there to go, because it is doing a job
 * the incoming thing does not do. **Something worn** is last: armour and charms
 * are only ever displaced by a square that takes nothing else, so reaching this
 * rung at all means every other square refused.
 */
const NOTHING_TO_DISPLACE = 0;
const THE_SAME_KIND = 1;
const A_WEAPON = 2;
const SOMETHING_ELSE_HELD = 3;
const SOMETHING_WORN = 4;

function displacementCost(
  held: ItemInstance | null,
  incoming: ItemDef,
  instance: ItemInstance,
  tilesById: Record<string, TileDef>,
): number {
  // A pile the thing pours into costs nothing to make room in either: nothing
  // comes out, because there is nothing left of what went in. See `../lib/piles`.
  if (!held || fuses(held, instance, tilesById)) return NOTHING_TO_DISPLACE;
  const def = tilesById[held.tileId];
  const item = def ? resolveItem(def) : null;
  // A tile the catalogue has lost is something in the way and nothing more,
  // which is the same answer every other lookup here gives it.
  if (!item) return SOMETHING_ELSE_HELD;
  if (item.type === incoming.type) return THE_SAME_KIND;
  if (item.type === "weapon") return A_WEAPON;
  if (item.type === "armor" || item.type === "charm") return SOMETHING_WORN;
  return SOMETHING_ELSE_HELD;
}

/**
 * Whether this square could hold the thing, once whatever is in it has gone.
 *
 * The difference from {@link bodySlotHasRoom} is one square's occupant, and it
 * matters for exactly one rule: a hand holding a greatsword has its partner
 * spoken for, and the partner stops being spoken for the moment the greatsword
 * is the thing being traded out. Asked in the state the swap lands in, which is
 * the same state {@link swapInto} checks itself against.
 */
function squareCouldTake(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  kind: EquipSlot,
  home: EquipSlot,
  instance: ItemInstance,
  def: TileDef,
): boolean {
  if (!slotTakes(kind, def)) return false;
  // **A hand is a place you hold things, and holding a helmet is carrying it
  // rather than wearing it.** Both hands take anything you can carry — see
  // `./equipment`'s `handAccepts` — which is right for a drag onto the square
  // itself and wrong here: the button means "wear this", and a free fist is not
  // an answer to it. So a hand is a candidate only for a thing that belongs in
  // one, which is what keeps a second helm trading with the one on your head
  // instead of ending up in your grip.
  if (isHand(kind) && !isHand(home)) return false;
  if (bodySlotHasRoom(equipment, tilesById, kind, instance)) return true;
  if (!equipment[kind]) return false;
  const emptied: Equipment = { ...equipment, [kind]: null };
  return bodySlotHasRoom(emptied, tilesById, kind, instance);
}

/**
 * The square a thing goes into when somebody asks to equip it without saying
 * where.
 *
 * **What a drop on the equipment button means.** Dropping onto a square is
 * somebody naming the square, and the generous {@link slotTakes} rule answers
 * that — a hand takes anything you can carry. Dropping onto the button says
 * only "wear this", so this has to work out which square they would have aimed
 * at, and the answer has to hold for a kind of item nobody had written when it
 * was drafted.
 *
 * So it is a ranking rather than a lookup. **Every square the thing would be
 * equipped in is a candidate** — for an arcane stone that is both hands and the
 * charm, for a helm only your head, for a wearable pack only your back — and
 * they are sorted by two keys:
 *
 * 1. {@link displacementCost}: what making room there would cost you. An empty
 *    square beats a taken one, and among taken ones the ladder decides.
 * 2. Its {@link equipSlotOf} square — where the thing *belongs* — over any
 *    other, which is what settles a tie. Two free hands give a sword the one it
 *    is swung with; two swords give the same answer, so "replace the main hand"
 *    needs no rule of its own.
 *
 * Ties below that keep `EQUIP_SLOTS` order, so the answer is stable: a body
 * that has swapped nothing must not be offered a different square for asking
 * twice.
 *
 * `lands` is the move rules having the last word — `canMoveItem` bound to where
 * the drag started. The ranking knows what a *square* will take and cannot know
 * what the source end will accept back, and a swap has to satisfy both: a bag
 * coming off a hand cannot go into the bag it was dragged out of, because
 * nothing nests. So the best square the rules will honour wins, rather than the
 * best square outright. It defaults to honouring everything, for callers with
 * no board to ask against.
 *
 * With nothing honoured, this answers with the square the thing belongs in
 * anyway, and the move is then refused there. That is deliberate: answering
 * with no square at all would leave the release with nothing under the pointer
 * and fall through to a world drop, so a two-handed pike dropped on the button
 * while both hands are full would land on the floor.
 *
 * Null only for something with no square on a body at all — a berry, a rock, a
 * chest — where there is nothing for the button to mean.
 */
export function equipDestination(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  instance: ItemInstance,
  lands: (to: BodySlotRef) => boolean = () => true,
): BodySlotRef | null {
  const def = tilesById[instance.tileId];
  const item = def ? resolveItem(def) : null;
  const home = def ? equipSlotOf(def) : null;
  if (!def || !item || !home) return null;

  const ranked = EQUIP_SLOTS.filter((kind) =>
    squareCouldTake(equipment, tilesById, kind, home, instance, def),
  )
    .map((kind) => ({
      kind,
      cost: displacementCost(equipment[kind], item, instance, tilesById),
      belongs: kind === home ? 0 : 1,
    }))
    // Stable, so squares that tie on both keys stay in `EQUIP_SLOTS` order.
    .sort((a, b) => a.cost - b.cost || a.belongs - b.belongs);

  for (const { kind } of ranked) {
    if (lands({ kind })) return { kind };
  }
  return { kind: home };
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
  tilesById: Record<string, TileDef>,
  ref: ObjectRef,
  instance: ItemInstance,
): MapFile | null {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return null;
  // Poured into a pile already in there where one will take it, and appended
  // otherwise — with no capacity check, exactly as before. `dropDestinationAt`
  // only aims a throw at a box with a free square, which is the *conservative*
  // half of this: a full box of berries refuses to catch a berry and the throw
  // lands on the floor instead. Nothing over-promises, and the fix if that ever
  // grates is one question further up, not a second rule here.
  const contents = placed.contents ?? [];
  return withGroundContents(
    map,
    ref,
    pourInto(contents, instance, tilesById) ?? [...contents, instance],
  );
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
 *
 * **Landing on a taken square on a body trades the two things.** It used to
 * refuse, on the grounds that equipping should never quietly put down what you
 * were holding — and that is still the rule everywhere nobody named a square:
 * see `./affordances`' `equipSlotFrom`, which only ever offers an empty one, so
 * the row in the world cannot cost you your sword. A drag is the opposite case.
 * Somebody has taken hold of a thing and let go of it over one particular
 * square; refusing that meant unequipping first and dragging again, with a bag
 * that had to have room for the gap in between. What comes out goes where the
 * dragged thing came from — see {@link swapInto} — so a swap is one gesture and
 * its own undo.
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
  // A stone that is still cooling stays where it is. The second cross-cutting
  // square rule, asked here because this is where every player-initiated move
  // passes — equipping, unequipping, looting and stashing are one operation
  // read four ways, so one gate covers all four. See `./equipment`'s
  // `stoneLocked` for what it is protecting.
  if (stoneLocked(instance, tilesById)) return null;
  if (!slotAccepts(to.kind, instance, tilesById)) return null;
  // A taken square on a body is no longer the end of it: the two things change
  // places. See {@link swapInto}, and note that a container destination has no
  // version of this — it appends, so it is never "taken" to begin with.
  if (!slotHasRoom(map, tilesById, actor, equipment, to, instance)) {
    return isBodySlot(to)
      ? swapInto(map, tilesById, actor, equipment, from, to, instance)
      : null;
  }

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
 * Put a thing into a square that is already taken, and send what was in it back
 * the way the new one came.
 *
 * **Only a square on a body, and only because those are the squares that hold
 * exactly one thing.** A container appends — its slots fill in order and a
 * destination index means nothing — so there is no "the thing that was there"
 * to hand back, which is why a full bag still refuses rather than trading.
 *
 * Both slots are emptied before either is filled, and that is the whole of the
 * correctness here. A swap is two moves that each have to be legal in the state
 * the other leaves behind: a greatsword may enter a hand whose partner is about
 * to be emptied, and the dagger coming out of it may not go back into a hand
 * the greatsword now claims. Asking each half against the emptied pair gets
 * both right, where checking against the state as it stands would refuse the
 * first and allow the second.
 *
 * Everything the outward half is held to, the returning half is held to as
 * well: it must be a thing the source slot would accept — a bag coming off a
 * hand may not go back into the bag it came out of, because nothing nests — and
 * it must be free to move, which a cooling stone is not. Refusing outright
 * rather than dropping it somewhere else is the only honest answer: there is no
 * second destination the player asked for.
 */
function swapInto(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  from: SlotRef,
  to: BodySlotRef,
  instance: ItemInstance,
): ItemMoveResult | null {
  const displaced = equipment[to.kind];
  // Nothing there means the caller is here for some other refusal — a hand
  // spoken for by a two-hander, most likely — and there is nothing to trade.
  if (!displaced?.id) return null;
  // **Two of the same thing is not a trade.** A pile that would not take yours
  // — four berries against a ceiling of three — has already been through
  // {@link bodySlotHasRoom} and been refused, and exchanging the two piles
  // answers a question nobody asked: you would be holding the number you were
  // trying to add to. Told apart from a genuine trade by there being more than
  // one of something, which is what a pile *is*; two single swords of one tile
  // are still two swords, and one of them may be written on.
  if (
    displaced.tileId === instance.tileId &&
    countOf(displaced) + countOf(instance) > 2
  ) {
    return null;
  }
  if (stoneLocked(displaced, tilesById)) return null;
  if (!slotAccepts(from.kind, displaced, tilesById)) return null;

  const source = clearSlot(map, tilesById, actor, equipment, from);
  if (!source) return null;
  const both = clearSlot(source.map, tilesById, actor, source.equipment, to);
  if (!both) return null;

  if (!slotHasRoom(both.map, tilesById, actor, both.equipment, to, instance)) {
    return null;
  }
  const filled = fillSlot(
    both.map,
    tilesById,
    actor,
    both.equipment,
    to,
    instance,
  );
  if (!filled) return null;

  if (
    !slotHasRoom(filled.map, tilesById, actor, filled.equipment, from, displaced)
  ) {
    return null;
  }
  return fillSlot(
    filled.map,
    tilesById,
    actor,
    filled.equipment,
    from,
    displaced,
  );
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
  if (isBodySlot(slot)) {
    if (!equipment[slot.kind]) return null;
    return { map, equipment: { ...equipment, [slot.kind]: null } };
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
 * Take exactly one thing out of a slot, leaving the rest of the pile behind.
 *
 * **The other way something leaves a slot**, and the distinction is the whole of
 * what a pile means to the rest of the game: a drop moves the pile and a meal
 * spends one of it. {@link clearSlot} is the first; this is the second, and the
 * two exist side by side so that neither has to take an amount nobody offered.
 *
 * Falls through to {@link clearSlot} for the last one, which is every item in
 * the game that is not food: peeling one off a pile of one empties the square,
 * exactly as eating a single berry always did.
 */
export function peelSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
): ItemMoveResult | null {
  const instance = itemInSlot(map, tilesById, actor, equipment, slot);
  if (!instance) return null;
  const left = peelOne(instance);
  if (!left) return clearSlot(map, tilesById, actor, equipment, slot);

  if (isBodySlot(slot)) {
    return { map, equipment: { ...equipment, [slot.kind]: left } };
  }
  if (slot.kind === "contents") {
    const where = contentsHolder(slot);
    const holder = equipment[where];
    const contents = holder?.contents;
    if (!holder || !contents) return null;
    return {
      map,
      equipment: {
        ...equipment,
        [where]: { ...holder, contents: replaceAt(contents, slot.index, left) },
      },
    };
  }
  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  const contents = placed?.contents;
  if (!contents) return null;
  return {
    map: withGroundContents(
      map,
      slot.ref,
      replaceAt(contents, slot.index, left),
    ),
    equipment,
  };
}

/**
 * Put a thing that exists nowhere yet into a slot, or refuse.
 *
 * The second half of {@link applyItemMove} on its own — may it go there, is
 * there room, put it there — for the callers that have a thing to place and no
 * slot it came out of: what a drink leaves behind, minted the moment it is
 * drunk. Asked against whatever kit the caller hands over, so a caller placing
 * something into the square a meal just vacated passes the kit with the meal
 * already gone.
 *
 * Null for every refusal, on {@link applyItemMove}'s terms: the caller's next
 * move is to try somewhere else, and there is nothing to say about why here.
 */
export function placeInSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
  instance: ItemInstance,
): ItemMoveResult | null {
  if (!slotAccepts(slot.kind, instance, tilesById)) return null;
  if (!slotHasRoom(map, tilesById, actor, equipment, slot, instance)) return null;
  return fillSlot(map, tilesById, actor, equipment, slot, instance);
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
  if (isBodySlot(slot)) {
    // The occupied case is a pour and nothing else — see {@link slotHasRoom},
    // which is the only thing that ever lets one through.
    const held = equipment[slot.kind];
    if (held) {
      if (!fuses(held, instance, tilesById)) return null;
      const fused = withCount(held, countOf(held) + countOf(instance));
      return { map, equipment: { ...equipment, [slot.kind]: fused } };
    }
    return { map, equipment: { ...equipment, [slot.kind]: instance } };
  }

  if (slot.kind === "contents") {
    const where = contentsHolder(slot);
    const holder = equipment[where];
    if (!holder) return null;
    const contents = stow(
      holder.contents ?? [],
      instance,
      capacityOf(holder, tilesById),
      tilesById,
    );
    if (!contents) return null;
    return {
      map,
      equipment: { ...equipment, [where]: { ...holder, contents } },
    };
  }

  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  const contents = stow(placed.contents ?? [], instance, size, tilesById);
  if (!contents) return null;
  return {
    map: withGroundContents(map, slot.ref, contents),
    equipment,
  };
}

/** A copy with one entry gone, so the list stays holeless. */
function removeAt(contents: ItemInstance[], index: number): ItemInstance[] {
  return contents.filter((_, i) => i !== index);
}

/**
 * A copy with one entry rewritten, which is a pile that is smaller than it was.
 *
 * The only edit in this module that leaves a list the same length: everything
 * else here adds or removes a thing, and a pile losing one of itself is neither.
 */
function replaceAt(
  contents: readonly ItemInstance[],
  index: number,
  instance: ItemInstance,
): ItemInstance[] {
  return contents.map((held, i) => (i === index ? instance : held));
}
