import { getStack } from "../lib/mapData";
import { hasLineOfSight } from "./sight";
import type {
  PlacedReward,
  PlacedTeleport,
  TransmuteInteraction,
} from "../lib/interactions";
import {
  isInteractive,
  resolvePush,
  resolveReward,
  resolveSwitch,
  resolveTeleport,
  resolveTransmute,
} from "../lib/interactions";
import {
  resolveConsumable,
  resolveContainer,
  resolveItem,
} from "../lib/item";
import type { EquipSlot } from "../lib/kit";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { physicalHeight } from "../lib/types";
import { canReplaceStack, fitsTile } from "../lib/validation";
import { handAccepts, type Equipment } from "./equipment";
import { pushDestination } from "./push";

/** A specific placed tile in the map — cell plus slot in its stack. */
export type ObjectRef = Coord & { stackIndex: number };

/** The part of an actor these questions need: where they are standing. */
export type Actor = Coord;

/** Floors above/below an actor that still count for hover and interaction. */
export const INTERACT_LEVEL_SLACK = 1;

/**
 * What an actor can do to an object, as plain functions of the board.
 *
 * Kept out of the session because both ends of the wire ask: the server to
 * validate an interaction it is told about, and the client to decide whether to
 * draw an affordance under the cursor. A client that had to ask the server
 * whether a crate is pushable would light up a round trip late, so it answers
 * locally from the same rules — and because they are the same rules, it cannot
 * disagree with the server about what it offered.
 *
 * Nothing here reads or writes motion state. "Is this actor busy" is a session
 * question and gates these separately; see `GameSession.idle`.
 */

/**
 * Is the object on a floor this actor can get at from where they stand?
 *
 * The half of reaching that has nothing to do with plan distance, split out
 * because the gestures disagree about the plan and agree about this. Taking a
 * thing reaches the round {@link REACH_CELLS}; a shove, a switch and a doorway
 * take push's orthogonal step. All of them mean the same thing by "a floor up
 * or down, if there is a way through".
 *
 * {@link INTERACT_LEVEL_SLACK} on its own is what lets you crouch at the lip of
 * a ledge and work the lever below it; on its own it also let you shut a door in
 * the cellar while standing on the ground above it, which reads as reaching
 * through solid earth because that is exactly what it was.
 *
 * {@link hasLineOfSight} answers the "way through" half, rather than a fresh
 * test for a floor in between, because it is the same question
 * {@link dropDestinationAt} already asks of the same slack: a cell you can lob a
 * torch into is one you could have touched had it been nearer. Sharing the
 * question means a reach, a throw and a shove can never disagree about which
 * floors are joined.
 *
 * **Reaching sideways is untouched.** A look never tests its own endpoints
 * sideways — see `./sight` — so the door beside you is still the door beside
 * you, and only crossing a floor can be refused here.
 */
function reachesAcrossFloors(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  to: Coord,
): boolean {
  if (Math.abs(to.z - actor.z) > INTERACT_LEVEL_SLACK) return false;
  return hasLineOfSight(map, tilesById, actor, to);
}

/**
 * Interactive object at a stack slot, if the actor could be looking at it.
 *
 * Buried under something solid is out, read through {@link coveredBySomething}
 * — the same rule pick-up takes, so a lever with a sword lying across it is
 * still a lever and one under a crate is not. Pushing does *not* come through
 * here; see {@link pushableDefAt} for why reaching under is fine there.
 */
export function interactiveDefAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): TileDef | null {
  if (!reachesAcrossFloors(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  if (!def || !isInteractive(def)) return null;
  return def;
}

/**
 * Pushable object at a stack slot, if the actor could shove it.
 *
 * **The one action that reaches under a lid**, and it does so because nothing
 * is left behind: a shove takes the whole {@link pushedColumn} with it, so the
 * crate on top of the crate you leant on arrives in the next cell too. Asking
 * "is it buried" here would refuse exactly the shove a player expects to work —
 * a stack of two boxes is two boxes you can push.
 *
 * A **body riding on top refuses the shove**, and that is the one thing a
 * column cannot carry. Somebody standing on a crate has their own motion and
 * their own idea of where they are walking to; sliding the ground out from
 * under them mid-step would commit that walk from a cell they are no longer in.
 * A body is not a lid — it does not hide what is beneath it — but it is not
 * cargo either.
 */
export function pushableDefAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): TileDef | null {
  if (!reachesAcrossFloors(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  for (let above = ref.stackIndex + 1; above < stack.length; above++) {
    if (stack[above]?.owner) return null;
  }
  const def = tilesById[placed.tileId];
  if (!def || !resolvePush(def)) return null;
  return def;
}

/**
 * Direction the actor would shove this object, or null when they are not
 * standing next to it. Orthogonal only: a diagonal push has no unambiguous
 * "one cell further away" cell, and reading it off the board is guesswork.
 * Floors are not part of the test — reaching one level up or down is fine
 * (see {@link INTERACT_LEVEL_SLACK}); it is the plan view that must touch.
 */
export function pushDirectionFrom(
  actor: Actor,
  ref: ObjectRef,
): Direction | null {
  const dx = ref.x - actor.x;
  const dy = ref.y - actor.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  if (dx === 1) return "e";
  if (dx === -1) return "w";
  return dy === 1 ? "s" : "n";
}

/** Where this object would land if pushed, or null when it cannot be. */
export function pushTargetFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): Coord | null {
  const def = pushableDefAt(map, tilesById, actor, ref);
  const push = def && resolvePush(def);
  if (!def || !push) return null;

  const direction = pushDirectionFrom(actor, ref);
  if (!direction) return null;

  const check = pushDestination(map, ref, direction, def, push, tilesById);
  return check.ok ? check.to : null;
}

/** Would the switch target fit in this stack slot? */
export function switchWouldFit(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ref: ObjectRef,
  targetTileId: string,
): boolean {
  if (!tilesById[targetTileId]) return false;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (!stack[ref.stackIndex]) return false;
  const next = stack.map((p, i) =>
    i === ref.stackIndex ? { ...p, tileId: targetTileId } : p,
  );
  return canReplaceStack(map, ref.x, ref.y, ref.z, next, tilesById).ok;
}

/**
 * Can this actor switch the object? Same reach as push, plus the target tile
 * having somewhere to go.
 */
export function canSwitchFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  const sw = def && resolveSwitch(def);
  if (!def || !sw || !pushDirectionFrom(actor, ref)) return false;
  return switchWouldFit(map, tilesById, ref, sw.targetTileId);
}

/** Can this actor push the object, ignoring whether they are mid-motion? */
export function canPushFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  return pushTargetFrom(map, tilesById, actor, ref) != null;
}

/**
 * How far an actor can reach to touch something, in cells.
 *
 * **Round, and deliberately not push's rule.** A shove needs an unambiguous
 * "one cell further away", so it is orthogonal and adjacent; reaching out to
 * pick a thing up or look inside it has no such constraint, and a player who
 * could not take the sword lying diagonally at their feet would read that as a
 * bug rather than as a rule.
 *
 * 1.5 squares to `dx² + dy² ≤ 2.25`, which is the eight neighbours plus the
 * cell you are standing in and nothing else — a diagonal is 2, and two cells
 * out is 4.
 */
export const REACH_CELLS = 1.5;

const REACH_CELLS_SQUARED = REACH_CELLS * REACH_CELLS;

/**
 * Can this actor actually put a hand on the object?
 *
 * {@link REACH_CELLS} of plan distance and then the floors question every other
 * gesture asks — see {@link reachesAcrossFloors}, which owns the slack and the
 * "is there a way through" half. The plan test comes first because it is two
 * multiplications and rules out most of what is ever asked about.
 */
export function withinReach(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const dx = ref.x - actor.x;
  const dy = ref.y - actor.y;
  if (dx * dx + dy * dy > REACH_CELLS_SQUARED) return false;
  return reachesAcrossFloors(map, tilesById, actor, ref);
}

/**
 * Does this placement hide what is underneath it?
 *
 * **Height is the whole rule, and a body never counts.** A sword, a coin, a
 * berry are flat — they add no volume to the stack, they are drawn beside what
 * they are lying on rather than over it, and a player looking at two of them in
 * one cell sees two things they could pick up. A crate is a metre of wood and
 * genuinely in the way. So the line is `physicalHeight > 0`, which is the same
 * line the stacking model already draws between things that take up room and
 * things that merely rest somewhere.
 *
 * The body exception is older and separate: standing on a sword does not bury
 * it, and a chest with somebody on top is a chest you can still open. Any body,
 * not only your own — two people standing over one sword either both reach it or
 * neither does, and "whoever stepped on it owns it" is a rule nothing else in
 * the game plays by. Without it the round pick-up radius would contradict
 * itself, since it takes in the cell you are standing in on purpose.
 */
function isLid(
  placed: PlacedTile | undefined,
  tilesById: Record<string, TileDef>,
): boolean {
  if (!placed || placed.owner) return false;
  const def = tilesById[placed.tileId];
  return def != null && physicalHeight(def) > 0;
}

/**
 * Is anything actually lying on top of this slot?
 *
 * "Anything" is {@link isLid} — something with volume and nobody in it. Two
 * swords in one cell therefore cover neither: they are both reachable, and the
 * list of things to do offers both.
 *
 * Exported for `../render/nearbyDescriptions`, which asks the same question of
 * the same radius: a sign under a crate has nothing to say, and a sign you are
 * standing on still does.
 */
export function coveredBySomething(
  stack: PlacedTile[],
  index: number,
  tilesById: Record<string, TileDef>,
): boolean {
  for (let above = index + 1; above < stack.length; above++) {
    if (isLid(stack[above], tilesById)) return true;
  }
  return false;
}

/**
 * The slot a thing thrown at this cell would land on — the topmost placement
 * that is not a body, or -1 for a cell holding nothing but bodies.
 *
 * A body is not a lid here either: a chest with somebody standing on it is
 * still the thing at the top of that cell, and a sword tossed at it should go
 * in the chest rather than land on their head.
 */
function topmostThingIn(stack: readonly PlacedTile[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i]?.owner) return i;
  }
  return -1;
}

/**
 * The item at a stack slot, if it is one and the actor could reach it.
 *
 * Deliberately not routed through {@link interactiveDefAt}: that one gates on
 * `isInteractive`, which asks whether the *tile* offers push or switch, and an
 * item offers neither. What it does share is the spirit of the top-of-stack
 * rule — something under a crate is not something you can pick up — but read
 * through {@link coveredBySomething}, which does not count a body as cover.
 */
export function reachableItemDefAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): TileDef | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  if (!def || !resolveItem(def)) return null;
  return def;
}

/**
 * The slot on a body this thing belongs in, from the tile alone.
 *
 * **One slot per thing, and the tile decides which.** A sword is for the hand
 * you swing with, a shield for the other one (`WeaponItem.offhand`), a mail
 * shirt for your body (`ArmorItem`), a backpack for your back
 * (`ContainerItem.equippable`), and an `ArtifactItem` — a torch, a lantern — for
 * the off hand always, since the swinging hand is the one that replaces what you
 * fight with. Everything else — a berry, a chest, a rock — has no slot and can
 * only be carried in a bag.
 *
 * One rather than "every slot that would take it", because the alternative is a
 * list that offers to Wield *and* Hold the same sword and a player who has to
 * decide which hand a thing goes in every time they pick one up. Where a thing
 * belongs is a fact about the thing.
 *
 * It is not the same question as "may this slot hold this" — `itemMoves`'
 * `slotAccepts` is looser and stays looser, because a drag is somebody saying
 * exactly what they want. This is what happens when they do not say. **Armour is
 * the one thing the two agree about**, since its square takes nothing else.
 *
 * Re-exported from `../lib/kit` rather than spelled out here, which it was: a
 * second list of the slots is a second list to forget a slot from, and this one
 * had already been written before the body square existed.
 */
export type { EquipSlot };

export function equipSlotOf(def: TileDef): EquipSlot | null {
  const item = resolveItem(def);
  if (!item) return null;

  // Never into a bag: containers do not nest, so the only place one can go is
  // a back. A chest or a corpse is looted where it lies — that is what `open`
  // is for — and has no slot at all.
  if (item.type === "container") return item.equippable ? "bag" : null;
  if (item.type === "armor") return "armor";
  // Needs no flag of its own to say so, where a weapon does: an artifact has no
  // fight in it, and the hand you swing with is the square whose contents stand
  // in for your natural weapon. See `../lib/item`'s `ArtifactItem`.
  if (item.type === "artifact") return "offhand";
  if (item.type === "weapon") return item.offhand ? "offhand" : "weapon";
  return null;
}

/**
 * Which of this actor's slots is empty and waiting for the thing at `ref`.
 *
 * **Equipping off the floor is not picking up**, which is the whole reason this
 * is a question of its own: a sword goes into your hand, and a hand is not a
 * pocket. It is what lets somebody with no bag at all arm themselves — the case
 * that used to be reachable only for a backpack, since that was the one thing
 * with somewhere to go.
 *
 * The slot has to be **empty**. Equipping never displaces what you are already
 * holding: a swap is two deliberate acts, and a tap that quietly put your sword
 * on the floor to make room for a worse one is the kind of thing you notice a
 * fight later. Taking the second sword is what the bag is for.
 */
export function equipSlotFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): EquipSlot | null {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  const slot = def && equipSlotOf(def);
  if (!slot) return null;
  return equipment[slot] ? null : slot;
}

/** Could this actor equip the thing where it lies? @see equipSlotFrom */
export function canEquipFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): boolean {
  return equipSlotFrom(map, tilesById, actor, ref, equipment) != null;
}

/**
 * Where a thing would go if this actor simply took it.
 *
 * - `"contents"` — into the bag, which is where anything you are merely
 *   carrying belongs.
 * - a hand — because a full bag should not be the end of the conversation. You
 *   have hands; a thing you can hold is a thing you can pick up, and the
 *   alternative is standing over a sword you cannot have.
 *
 * **A hand is the last place this looks, and never one the equip row is already
 * offering.** Where a thing *belongs* is `equipSlotFrom`'s answer and it has a
 * row of its own with its own verb; a pickup that also reached for that slot
 * would put "Wield" and "Pick up" beside each other meaning the same thing. So
 * the hands come up only once the bag is out of room *and* the thing has no free
 * slot of its own — which is exactly when there is nowhere else at all. It
 * follows that the two rows can never name one outcome, and neither has to ask
 * about the other.
 *
 * The off hand before the weapon hand. What you swing with is the slot with
 * consequences — see `weaponInHand` — and a pickup with nowhere else to go
 * should reach for the spare hand rather than rewrite what you are fighting
 * with.
 *
 * A container never goes in the bag, wearable or not: nothing nests. A wearable
 * one can still end up in a hand, since a hand takes anything you can carry.
 */
export type PickUpDestination =
  | { kind: "contents" }
  | { kind: "slot"; slot: "weapon" | "offhand" };

export function pickUpDestination(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): PickUpDestination | null {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  if (!def) return null;

  if (!resolveContainer(def) && bagHasRoom(tilesById, equipment)) {
    return { kind: "contents" };
  }

  // Where the thing belongs has its own row with its own verb, so a pickup that
  // reached for that slot too would put "Wield" and "Pick up" side by side
  // meaning one thing. The hands come up only once nowhere else will have it.
  const belongs = equipSlotOf(def);
  if (belongs && !equipment[belongs]) return null;

  if (!handAccepts(def)) return null;
  if (!equipment.offhand) return { kind: "slot", slot: "offhand" };
  if (!equipment.weapon) return { kind: "slot", slot: "weapon" };
  return null;
}

/** Could this actor take the thing at all? @see pickUpDestination */
export function canPickUpFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): boolean {
  return pickUpDestination(map, tilesById, actor, ref, equipment) != null;
}

/** Is there a free square inside the bag on this actor's back? */
function bagHasRoom(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): boolean {
  const bag = equipment.bag;
  if (!bag) return false;
  const bagDef = tilesById[bag.tileId];
  const size = bagDef ? (resolveContainer(bagDef)?.size ?? 0) : 0;
  return (bag.contents?.length ?? 0) < size;
}

/**
 * How far an actor can throw something down, in cells.
 *
 * Deliberately much further than {@link REACH_CELLS}, and the difference is the
 * point: taking a thing requires touching it, while putting one down is an
 * underarm toss at somewhere you can see. Five cells is far enough to place a
 * torch across a room and near enough that you are still furnishing the space
 * you are standing in.
 */
export const DROP_CELLS = 5;

const DROP_CELLS_SQUARED = DROP_CELLS * DROP_CELLS;

/**
 * Where a thing thrown at a cell actually ends up.
 *
 * - `"stack"` — on the floor of that cell, on top of whatever is there.
 * - `"contents"` — inside the container it landed on, which is the slot named.
 *
 * **A box catches what you throw at it.** Dropping a sword onto a chest and
 * watching it land *beside* the chest is the kind of thing a player does once,
 * shrugs at, and then works around for the rest of the game by opening the
 * panel — so the box takes it when the box has room, and the floor takes it when
 * it does not. Nothing is refused for being aimed at a full chest; it simply
 * lands on top, which is what the throw would have done anyway.
 *
 * Only the top thing catches, and a body is not one — see
 * {@link topmostThingIn}. A chest under a crate is a chest with a lid on it.
 *
 * Containers never go inside containers, so a bag thrown at a chest lands on it.
 * That rule lives in one place for moves (`itemMoves`' `slotAccepts`) and this
 * is the board's half of it.
 *
 * Three questions gate the throw itself, and each rules out a different way of
 * cheating. **Range**, because a drop is a throw and not a teleport. **Line of
 * sight**, because the range is long enough to reach through a wall otherwise —
 * the one rule pick-up has no need of, since everything within arm's length is
 * already in the open. And **room**, either in the box or in the stack, the
 * latter asked through `canReplaceStack`: the same question the editor asks when
 * it places a tile.
 *
 * The tile rather than the instance, because none of this depends on which
 * particular sword it is — only on how tall it is and what it is made of.
 */
export type DropDestination =
  | { kind: "stack" }
  | { kind: "contents"; ref: ObjectRef };

export function dropDestinationAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  to: Coord,
  def: TileDef,
): DropDestination | null {
  const dx = to.x - actor.x;
  const dy = to.y - actor.y;
  if (dx * dx + dy * dy > DROP_CELLS_SQUARED) return null;
  if (Math.abs(to.z - actor.z) > INTERACT_LEVEL_SLACK) return null;
  if (!hasLineOfSight(map, tilesById, actor, to)) return null;

  // Something has to be there already. An empty cell is not "room" — it is a
  // hole in the world, and a sword thrown into one is a sword nobody gets back.
  // Every playable cell has at least a floor, so this reads as "somewhere that
  // exists" rather than as a rule anybody has to think about.
  const stack = getStack(map, to.x, to.y, to.z);
  if (stack.length === 0) return null;

  const stackIndex = topmostThingIn(stack);
  const caught = stack[stackIndex];
  const catcher = caught && tilesById[caught.tileId];
  const container = catcher ? resolveContainer(catcher) : null;
  if (
    caught &&
    container &&
    resolveContainer(def) == null &&
    (caught.contents?.length ?? 0) < container.size
  ) {
    return { kind: "contents", ref: { ...to, stackIndex } };
  }

  const next = [...stack, { tileId: def.id }];
  if (!canReplaceStack(map, to.x, to.y, to.z, next, tilesById).ok) return null;
  return { kind: "stack" };
}

/** Can this actor put a thing down at this cell? @see dropDestinationAt */
export function canDropAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  to: Coord,
  def: TileDef,
): boolean {
  return dropDestinationAt(map, tilesById, actor, to, def) != null;
}

/**
 * Could this actor eat or drink the thing where it lies?
 *
 * The same reach a pickup has and nothing more: nothing about the actor's own
 * kit is consulted, because a consumable used from the floor never enters it —
 * a full bag is exactly when eating the cherry off the ground is the thing you
 * want.
 */
export function canConsumeFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  return def != null && resolveConsumable(def) != null;
}

/**
 * The reward at a stack slot, if there is one and the actor could reach it.
 *
 * Read off the *placement* and the tile together — see `resolveReward`, which
 * owns that join. The tile says whether this kind of thing gives anything at
 * all; the slot says what and under which tag, so the same chest tile can be a
 * dozen different rewards across a map.
 *
 * Reach is the round {@link REACH_CELLS} rather than push's orthogonal step, on
 * the same grounds pick-up and open take it: being handed a thing needs no
 * unambiguous "one cell further away", and an NPC standing diagonally who could
 * not give you the sword would read as a bug.
 *
 * Routed through the same cover rule pick-up uses — a chest under a crate is out
 * of reach, a chest with somebody standing on it is not. Which matters more here
 * than anywhere: the giver is very often a *body*, and every body has somebody
 * in it.
 */
export function reachableRewardAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): PlacedReward | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  return resolveReward(placed, tilesById[placed.tileId]);
}

/**
 * Is there room for every last thing in this reward?
 *
 * **All or nothing**, and that is the rule the whole affordance rests on: a
 * reward is taken once, so half of one is half of it lost for ever. A player
 * with one free slot standing at a two-item chest is told no and can go and make
 * room, which is the only outcome that leaves the sword still in the box.
 *
 * Containers are refused outright rather than routed to the bag slot. A
 * container cannot go in a bag — nothing nests — so its only home is a back that
 * is bare, and a reward that quietly meant "and also I am taking your backpack
 * off" is not something an author can see themselves writing. A reward tile id
 * that names a container, or a wall, or nothing at all, therefore makes the
 * whole reward untakeable and visibly so.
 */
export function rewardFits(
  reward: PlacedReward,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): boolean {
  const bag = equipment.bag;
  if (!bag) return false;
  const bagDef = tilesById[bag.tileId];
  const size = bagDef ? (resolveContainer(bagDef)?.size ?? 0) : 0;
  const free = size - (bag.contents?.length ?? 0);
  if (reward.itemTileIds.length > free) return false;

  return reward.itemTileIds.every((tileId) => {
    const def = tilesById[tileId];
    if (!def) return false;
    return resolveItem(def) != null && resolveContainer(def) == null;
  });
}

/**
 * Could this actor take the reward right now?
 *
 * Three refusals, and they are deliberately not distinguished: already taken, no
 * room, badly authored. Whichever it is, there is no row and no outline — a
 * reward is either on offer or it is not there, which is what makes an emptied
 * chest read as scenery rather than as something withholding.
 *
 * @param tags what this actor has already been marked with. Holding the
 *   reward's own tag is what closes it, and that is the whole of "once per
 *   player" — see {@link RewardInteraction.tag}.
 */
export function canRewardFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
  tags: readonly string[],
): boolean {
  const reward = reachableRewardAt(map, tilesById, actor, ref);
  if (!reward) return false;
  if (tags.includes(reward.tag)) return false;
  return rewardFits(reward, tilesById, equipment);
}

/**
 * The recipes at a stack slot, if this actor could reach whatever is offering
 * them.
 *
 * The tile's half and all of it — a transmuter has no placement half to join,
 * unlike a reward or a teleport, because what a fire does to meat is a fact
 * about fire. So this is `resolveTransmute` plus the reach every other reaching
 * affordance takes.
 *
 * Reach is the round {@link REACH_CELLS} rather than push's orthogonal step, on
 * the same grounds a reward's is: handing a trader a carcass needs no
 * unambiguous "one cell further away", and a salesman standing diagonally who
 * would not deal with you would read as a bug.
 *
 * Cover is the rule everything else takes — a fire under a crate is out — and a
 * body is not cover, which matters here for the reason it matters to a reward:
 * half the transmuters worth authoring are people.
 *
 * Says nothing about whether the actor has anything to spend. That is a
 * question about their kit and it is `../game/transmute`'s.
 */
export function reachableTransmuteAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): TransmuteInteraction | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  return def ? resolveTransmute(def) : null;
}

/**
 * The teleport at a stack slot, if there is one and this actor could set it off
 * by pressing it.
 *
 * Read off the *placement* and the tile together — see `resolveTeleport`, which
 * owns that join and resolves a relative destination against the cell. The tile
 * says whether this kind of thing moves anybody at all and how; the slot says
 * where to, so the same portal tile can be a dozen different doors across a map.
 *
 * **Two reaches, because there are two gestures.** An `interact` teleport takes
 * push's orthogonal step, exactly as a switch does: a doorway is the thing you
 * are squarely beside, and a diagonal has no such reading. An `interactOver` one
 * takes no reach at all — you must be standing in its cell — because that is the
 * whole difference between the two, and a ladder you could climb from the next
 * square over would not be a ladder.
 *
 * A `step` teleport is never here. Nothing about it answers to a press, so
 * offering it would outline a floor tile and put a row on screen for something
 * that has already happened by the time you could read it. See
 * `../game/GameSession.teleportOnLanding`, which is what fires those.
 *
 * Cover is the same rule everything else takes — a portal under a crate is out —
 * and it is `interactiveDefAt` that asks. Bodies are not lids, which is what
 * makes `interactOver` possible at all: you are standing on the rungs.
 */
export function reachableTeleportAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): PlacedTeleport | null {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  if (!def) return null;
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return null;

  const teleport = resolveTeleport(placed, def, ref);
  if (!teleport) return null;

  if (teleport.trigger === "interact") {
    return pushDirectionFrom(actor, ref) ? teleport : null;
  }
  if (teleport.trigger === "interactOver") {
    const over =
      actor.x === ref.x && actor.y === ref.y && actor.z === ref.z;
    return over ? teleport : null;
  }
  return null;
}

/**
 * Is there room at the far end for the body making the trip?
 *
 * The "if they fit" half of a teleport, and it is asked of the *traveller's own
 * tile* rather than of the player's — a deer that walks onto a portal is a
 * different height from the person who authored it, and the cell that holds one
 * need not hold the other.
 *
 * {@link fitsTile} is the same predicate the editor places against and the one
 * an entering player is put down by (see `./entry`), which is the point of
 * reusing it: a destination the editor would refuse is one nobody can arrive at.
 * What is *below* the feet is left to gravity, exactly as it is for an arrival —
 * this decides where the traveller lands, not where they end up.
 */
export function teleportFits(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  travellerDef: TileDef,
  to: Coord,
): boolean {
  return fitsTile(map, to.x, to.y, to.z, travellerDef, tilesById).ok;
}

/**
 * Could this actor go through right now?
 *
 * Two refusals and they are deliberately not distinguished, on the same terms a
 * reward's are: nothing authored here, or nowhere to stand at the far end.
 * Either way there is no row and no outline, so a blocked portal reads as
 * scenery rather than as a door being unhelpful.
 */
export function canTeleportFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  travellerDef: TileDef,
): boolean {
  const teleport = reachableTeleportAt(map, tilesById, actor, ref);
  if (!teleport) return false;
  return teleportFits(map, tilesById, travellerDef, teleport.to);
}

/**
 * Could this actor look inside the thing?
 *
 * Every container in reach, whether or not it could be carried — a chest that
 * can never leave the floor is precisely the one worth opening, and a backpack
 * you have no room for is still worth rummaging in.
 *
 * Nothing about the actor's own kit is consulted, which is why this takes no
 * equipment: opening is looking, and looking costs nothing.
 */
export function canOpenFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  return def != null && resolveContainer(def) != null;
}
