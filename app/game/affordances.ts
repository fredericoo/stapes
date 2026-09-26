import { resolveDialog } from "../lib/dialog";
import { absoluteStandingElevation, getStack, walkableElevInStack } from "../lib/mapData";
import { hasLineOfSight } from "./sight";
import type {
  AddStatusInteraction,
  PlacedReward,
  PlacedTeleport,
  RemoveStatusInteraction,
  SetSpawnInteraction,
  CraftInteraction,
} from "../lib/interactions";
import {
  isInteractive,
  resolveAddStatus,
  resolvePush,
  resolveRemoveStatus,
  resolveReward,
  resolveSetSpawn,
  resolveSwitch,
  resolveTeleport,
  resolveCraft,
} from "../lib/interactions";
import { armorSlotOf, resolveConsumable, resolveContainer, resolveItem } from "../lib/item";
import type { EquipSlot } from "../lib/kit";
import { stowFits } from "../lib/piles";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { physicalHeight } from "../lib/types";
import { canReplaceStack, fitsTile } from "../lib/validation";
import { PLAYER_TILE_ID } from "./constants";
import { handAccepts, handHasRoomFor, wornAccepts, type Equipment } from "./equipment";
import { pushDestination } from "./push";

export type ObjectRef = Coord & { stackIndex: number };

export type Actor = Coord;

export const INTERACT_LEVEL_SLACK = 1;

function reachesAcrossFloors(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  to: Coord,
): boolean {
  if (Math.abs(to.z - actor.z) > INTERACT_LEVEL_SLACK) return false;
  return hasLineOfSight(map, tilesById, actor, to);
}

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
  /**
   * A body standing on top refuses the push: it has its own motion, and
   * sliding the ground out from under it mid-step would commit that walk from
   * a cell it is no longer in.
   */
  for (let above = ref.stackIndex + 1; above < stack.length; above++) {
    if (stack[above]?.owner) return null;
  }
  const def = tilesById[placed.tileId];
  if (!def || !resolvePush(def)) return null;
  return def;
}

export function pushDirectionFrom(actor: Actor, ref: ObjectRef): Direction | null {
  const dx = ref.x - actor.x;
  const dy = ref.y - actor.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  if (dx === 1) return "e";
  if (dx === -1) return "w";
  return dy === 1 ? "s" : "n";
}

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

export function switchWouldFit(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ref: ObjectRef,
  targetTileId: string,
): boolean {
  if (!tilesById[targetTileId]) return false;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (!stack[ref.stackIndex]) return false;
  const next = stack.map((p, i) => (i === ref.stackIndex ? { ...p, tileId: targetTileId } : p));
  return canReplaceStack(map, ref.x, ref.y, ref.z, next, tilesById).ok;
}

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

export function canPushFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  return pushTargetFrom(map, tilesById, actor, ref) != null;
}

export const REACH_CELLS = 1.5;

const REACH_CELLS_SQUARED = REACH_CELLS * REACH_CELLS;

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

export const TALK_REACH_CELLS = 3.5;

const TALK_REACH_CELLS_SQUARED = TALK_REACH_CELLS * TALK_REACH_CELLS;

export const TALK_HEIGHT_SLACK = 3;

export function canTalkFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ObjectRef,
  ref: ObjectRef,
): boolean {
  const dx = ref.x - self.x;
  const dy = ref.y - self.y;
  if (dx * dx + dy * dy > TALK_REACH_CELLS_SQUARED) return false;
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  const def = placed && tilesById[placed.tileId];
  if (!def || !resolveDialog(def)) return false;
  const rise =
    standingElevationUnder(map, tilesById, ref) - standingElevationUnder(map, tilesById, self);
  if (Math.abs(rise) > TALK_HEIGHT_SLACK) return false;
  return hasLineOfSight(map, tilesById, self, ref);
}

function standingElevationUnder(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: ObjectRef,
): number {
  const stack = getStack(map, at.x, at.y, at.z);
  return absoluteStandingElevation(at.z, stack.slice(0, at.stackIndex), tilesById);
}

/** A body never counts as a lid, so standing on a sword does not bury it. */
function isLid(placed: PlacedTile | undefined, tilesById: Record<string, TileDef>): boolean {
  if (!placed || placed.owner) return false;
  const def = tilesById[placed.tileId];
  return def != null && physicalHeight(def) > 0;
}

export function coveredBySomething(
  stack: readonly PlacedTile[],
  index: number,
  tilesById: Record<string, TileDef>,
): boolean {
  for (let above = index + 1; above < stack.length; above++) {
    if (isLid(stack[above], tilesById)) return true;
  }
  return false;
}

function topmostThingIn(stack: readonly PlacedTile[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i]?.owner) return i;
  }
  return -1;
}

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

export type { EquipSlot };

export function equipSlotsFor(def: TileDef): readonly EquipSlot[] {
  const item = resolveItem(def);
  if (!item) return [];

  if (item.type === "container") return item.equippable ? ["bag"] : [];
  if (item.type === "armor") return [armorSlotOf(item)];
  if (item.type === "artifact") {
    return wornAccepts("charm", def) ? ["charm", "offhand"] : ["offhand"];
  }
  if (item.type === "shield") return ["offhand"];
  if (item.type === "stone") return ["offhand"];
  if (item.type === "charm") return ["charm"];
  if (item.type === "weapon") return ["weapon"];
  return [];
}

export function equipSlotFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): EquipSlot | null {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  if (!def) return null;
  for (const slot of equipSlotsFor(def)) {
    if (equipment[slot]) continue;
    if (slot === "weapon" || slot === "offhand") {
      if (!handHasRoomFor(equipment, tilesById, slot, def)) continue;
    }
    return slot;
  }
  return null;
}

export function canEquipFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): boolean {
  return equipSlotFrom(map, tilesById, actor, ref, equipment) != null;
}

export type PickUpDestination = { kind: "contents" } | { kind: "slot"; slot: "weapon" | "offhand" };

export function pickUpDestination(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): PickUpDestination | null {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  if (!def) return null;

  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return null;

  if (!resolveContainer(def) && bagTakes(tilesById, equipment, placed)) {
    return { kind: "contents" };
  }

  if (equipSlotsFor(def).some((slot) => !equipment[slot])) return null;

  if (!handAccepts(def)) return null;
  for (const hand of ["offhand", "weapon"] as const) {
    if (equipment[hand]) continue;
    if (handHasRoomFor(equipment, tilesById, hand, def)) {
      return { kind: "slot", slot: hand };
    }
  }
  return null;
}

export function canPickUpFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): boolean {
  return pickUpDestination(map, tilesById, actor, ref, equipment) != null;
}

function bagTakes(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  incoming: PlacedTile,
): boolean {
  const bag = equipment.bag;
  if (!bag) return false;
  const bagDef = tilesById[bag.tileId];
  const size = bagDef ? (resolveContainer(bagDef)?.size ?? 0) : 0;
  return stowFits(bag.contents ?? [], incoming, size, tilesById);
}

export const DROP_CELLS = 5;

const DROP_CELLS_SQUARED = DROP_CELLS * DROP_CELLS;

export type DropDestination = { kind: "stack" } | { kind: "contents"; ref: ObjectRef };

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

  if (walkableElevInStack(stack, tilesById) == null) return null;

  const next = [...stack, { tileId: def.id }];
  if (!canReplaceStack(map, to.x, to.y, to.z, next, tilesById).ok) return null;
  return { kind: "stack" };
}

export function canDropAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  to: Coord,
  def: TileDef,
): boolean {
  return dropDestinationAt(map, tilesById, actor, to, def) != null;
}

export function canConsumeFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  return def != null && resolveConsumable(def) != null;
}

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

export function reachableCraftAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): CraftInteraction | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  return def ? resolveCraft(def) : null;
}

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
    const over = actor.x === ref.x && actor.y === ref.y && actor.z === ref.z;
    return over ? teleport : null;
  }
  return null;
}

export function teleportFits(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  travellerDef: TileDef,
  to: Coord,
): boolean {
  return fitsTile(map, to.x, to.y, to.z, travellerDef, tilesById, {
    throughPlayers: travellerDef.id === PLAYER_TILE_ID,
  }).ok;
}

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

export function reachableAddStatusAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): AddStatusInteraction | null {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  if (!def) return null;

  const addStatus = resolveAddStatus(def);
  if (!addStatus) return null;

  if (addStatus.trigger === "interact") {
    return pushDirectionFrom(actor, ref) ? addStatus : null;
  }
  if (addStatus.trigger === "interactOver") {
    const over = actor.x === ref.x && actor.y === ref.y && actor.z === ref.z;
    return over ? addStatus : null;
  }
  return null;
}

export function canAddStatusFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  return reachableAddStatusAt(map, tilesById, actor, ref) != null;
}

export function reachableRemoveStatusAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): RemoveStatusInteraction | null {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  if (!def) return null;

  const removeStatus = resolveRemoveStatus(def);
  if (!removeStatus) return null;

  if (removeStatus.trigger === "interact") {
    return pushDirectionFrom(actor, ref) ? removeStatus : null;
  }
  if (removeStatus.trigger === "interactOver") {
    const over = actor.x === ref.x && actor.y === ref.y && actor.z === ref.z;
    return over ? removeStatus : null;
  }
  return null;
}

export function canRemoveStatusFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  return reachableRemoveStatusAt(map, tilesById, actor, ref) != null;
}

export function reachableSetSpawnAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): SetSpawnInteraction | null {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  if (!def) return null;

  const setSpawn = resolveSetSpawn(def);
  if (!setSpawn) return null;

  if (setSpawn.trigger === "interact") {
    return pushDirectionFrom(actor, ref) ? setSpawn : null;
  }
  if (setSpawn.trigger === "interactOver") {
    const over = actor.x === ref.x && actor.y === ref.y && actor.z === ref.z;
    return over ? setSpawn : null;
  }
  return null;
}

export function canSetSpawnFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  return reachableSetSpawnAt(map, tilesById, actor, ref) != null;
}

export function canOpenFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const def = reachableItemDefAt(map, tilesById, actor, ref);
  return def != null && resolveContainer(def) != null;
}
