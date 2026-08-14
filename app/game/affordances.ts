import { getStack } from "../lib/mapData";
import { hasLineOfSight } from "./sight";
import { isInteractive, resolvePush, resolveSwitch } from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import type { Equipment } from "./equipment";
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
 * Interactive object at a stack slot, if the actor could be looking at it.
 * Buried under another tile is out: only the top of a stack can be acted on.
 */
export function interactiveDefAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): TileDef | null {
  if (Math.abs(ref.z - actor.z) > INTERACT_LEVEL_SLACK) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (ref.stackIndex !== stack.length - 1) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  if (!def || !isInteractive(def)) return null;
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
  const def = interactiveDefAt(map, tilesById, actor, ref);
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

/** Is this object close enough to reach, in plan and in floors? */
export function withinReach(actor: Actor, ref: ObjectRef): boolean {
  if (Math.abs(ref.z - actor.z) > INTERACT_LEVEL_SLACK) return false;
  const dx = ref.x - actor.x;
  const dy = ref.y - actor.y;
  return dx * dx + dy * dy <= REACH_CELLS_SQUARED;
}

/**
 * Is anything actually lying on top of this slot?
 *
 * **A body is not a lid.** Standing on a sword does not bury it, and a chest
 * with somebody on top of it is a chest you can still open — the rule exists to
 * stop you reaching a thing under a *crate*, and a person who walked over it is
 * not one. Without this the round pick-up radius would contradict itself: it
 * takes in the cell you are standing in on purpose, and that is exactly the cell
 * your own body would otherwise cover.
 *
 * Any body, not only your own. Two people standing over one sword either both
 * reach it or neither does, and "whoever stepped on it owns it" is a rule
 * nothing else in the game plays by.
 */
function coveredBySomething(stack: PlacedTile[], index: number): boolean {
  for (let above = index + 1; above < stack.length; above++) {
    if (!stack[above]?.owner) return true;
  }
  return false;
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
  if (!withinReach(actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  if (!def || !resolveItem(def)) return null;
  return def;
}

/**
 * Where a thing would go if this actor picked it up, or null if nowhere.
 *
 * Three answers rather than a boolean, because "can I pick this up" and "where
 * does it land" are the same question asked once — the caller that says yes is
 * the caller that then has to put it somewhere, and deriving the destination a
 * second time is how the two come to disagree.
 *
 * - `"bag-slot"` — an equippable container, and the actor's back is free.
 * - `"contents"` — anything else, and there is room in the bag.
 *
 * A container that is *not* equippable can never be picked up, because no
 * container may hold a container and the bag slot will not take it. A corpse or
 * a chest is looted where it lies, which is what `open` is for.
 */
export type PickUpDestination = "bag-slot" | "contents";

export function pickUpDestination(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): PickUpDestination | null {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  if (!def) return null;

  const container = resolveContainer(def);
  if (container) {
    // Never into a bag: containers do not nest, so the only place one can go is
    // a back that has nothing on it yet.
    if (!container.equippable) return null;
    return equipment.bag ? null : "bag-slot";
  }

  const bag = equipment.bag;
  if (!bag) return null;
  const bagDef = tilesById[bag.tileId];
  const size = bagDef ? (resolveContainer(bagDef)?.size ?? 0) : 0;
  return (bag.contents?.length ?? 0) < size ? "contents" : null;
}

/** Could this actor pick the thing up right now? */
export function canPickUpFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): boolean {
  return pickUpDestination(map, tilesById, actor, ref, equipment) != null;
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
 * Can this actor put a thing down at this cell?
 *
 * Three questions, and each rules out a different way of cheating. **Range**,
 * because a drop is a throw and not a teleport. **Line of sight**, because the
 * range is long enough to reach through a wall otherwise — the one rule pick-up
 * has no need of, since everything within arm's length is already in the open.
 * And **room in the stack**, asked through `canReplaceStack`, which is the same
 * question the editor asks when it places a tile: a cell that cannot hold
 * another thing cannot hold this one either.
 *
 * The tile rather than the instance, because none of this depends on which
 * particular sword it is — only on how tall it is and what it is made of.
 */
export function canDropAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  to: Coord,
  def: TileDef,
): boolean {
  const dx = to.x - actor.x;
  const dy = to.y - actor.y;
  if (dx * dx + dy * dy > DROP_CELLS_SQUARED) return false;
  if (Math.abs(to.z - actor.z) > INTERACT_LEVEL_SLACK) return false;
  if (!hasLineOfSight(map, tilesById, actor, to)) return false;

  // Something has to be there already. An empty cell is not "room" — it is a
  // hole in the world, and a sword thrown into one is a sword nobody gets back.
  // Every playable cell has at least a floor, so this reads as "somewhere that
  // exists" rather than as a rule anybody has to think about.
  const stack = getStack(map, to.x, to.y, to.z);
  if (stack.length === 0) return false;

  const next = [...stack, { tileId: def.id }];
  return canReplaceStack(map, to.x, to.y, to.z, next, tilesById).ok;
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
