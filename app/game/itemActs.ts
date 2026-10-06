import {
  instanceFromPlacement,
  placementFromInstance,
  type ItemInstance,
} from "../lib/itemInstance";
import { resolveConsumable, type ConsumableItem } from "../lib/item";
import { getStack, removeTileAt, replaceStack } from "../lib/mapData";
import { appendItem, peelOne, stackWithItem, stow } from "../lib/piles";
import { canReplaceStack } from "../lib/validation";
import type { Coord, MapFile, TileDef } from "../lib/types";
import {
  canConsumeFrom,
  dropDestinationAt,
  equipSlotFrom,
  pickUpDestination,
  type Actor,
  type ObjectRef,
} from "./affordances";
import { stoneLocked, type Equipment } from "./equipment";
import type { ConsumeSource } from "./itemUse";
import { leaveResidue } from "./residue";
import {
  capacityOf,
  clearSlot,
  itemInSlot,
  peelSlot,
  stashInContainer,
  type ItemMoveResult,
  type SlotRef,
} from "./itemMoves";

function takeFromBoard(
  map: MapFile,
  ref: ObjectRef,
): { map: MapFile; instance: ItemInstance } | null {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  const instance = placed && instanceFromPlacement(placed);
  if (!instance) return null;
  return { map: removeTileAt(map, ref.x, ref.y, ref.z, ref.stackIndex), instance };
}

export function applyPickUp(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): ItemMoveResult | null {
  const destination = pickUpDestination(map, tilesById, actor, ref, equipment);
  if (!destination) return null;

  const taken = takeFromBoard(map, ref);
  if (!taken) return null;

  if (destination.kind === "slot") {
    return { map: taken.map, equipment: { ...equipment, [destination.slot]: taken.instance } };
  }

  const bag = equipment.bag;
  if (!bag) return null;
  const contents = stow(bag.contents ?? [], taken.instance, capacityOf(bag, tilesById), tilesById);
  if (!contents) return null;
  return { map: taken.map, equipment: { ...equipment, bag: { ...bag, contents } } };
}

export function applyEquip(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
  equipment: Equipment,
): ItemMoveResult | null {
  const slot = equipSlotFrom(map, tilesById, actor, ref, equipment);
  if (!slot) return null;

  const taken = takeFromBoard(map, ref);
  if (!taken) return null;
  return { map: taken.map, equipment: { ...equipment, [slot]: taken.instance } };
}

export type DropResult = ItemMoveResult & { onFloor: boolean };

export function applyDrop(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  from: SlotRef,
  to: Coord,
): DropResult | null {
  const instance = itemInSlot(map, tilesById, actor, equipment, from);
  const def = instance && tilesById[instance.tileId];
  if (!instance || !def) return null;
  if (stoneLocked(instance, tilesById)) return null;
  const destination = dropDestinationAt(map, tilesById, actor, to, def);
  if (!destination) return null;

  const emptied = clearSlot(map, tilesById, actor, equipment, from);
  if (!emptied) return null;

  if (destination.kind === "contents") {
    const landed = stashInContainer(emptied.map, tilesById, destination.ref, instance);
    return landed && { map: landed, equipment: emptied.equipment, onFloor: false };
  }
  const placed = placementFromInstance(instance);
  return {
    map: appendItem(emptied.map, to.x, to.y, to.z, placed, tilesById),
    equipment: emptied.equipment,
    onFloor: true,
  };
}

/**
 * `noRoom` names what the eaten thing leaves behind (a bottle, a core) when
 * nowhere near will hold it, which refuses the eating rather than losing it.
 */
export type ConsumeOutcome =
  | (ItemMoveResult & { kind: "eaten"; consumable: ConsumableItem; name: string })
  | { kind: "noRoom"; residue: TileDef };

/** `mintId` names the residue, so each side mints its own id for it. */
export function applyConsume(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  from: ConsumeSource,
  mintId: () => string,
): ConsumeOutcome | null {
  return from.kind === "floor"
    ? consumeFromFloor(map, tilesById, actor, equipment, from.ref, mintId)
    : consumeFromSlot(map, tilesById, actor, equipment, from.slot, mintId);
}

function residueOf(
  consumable: ConsumableItem,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): ItemInstance | null {
  const tileId = consumable.leaves;
  if (!tileId || !tilesById[tileId]) return null;
  return { id: mintId(), tileId };
}

function consumeFromFloor(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  mintId: () => string,
): ConsumeOutcome | null {
  if (!canConsumeFrom(map, tilesById, actor, ref)) return null;

  const stack = getStack(map, ref.x, ref.y, ref.z);
  const placed = stack[ref.stackIndex];
  const def = placed && tilesById[placed.tileId];
  const consumable = def ? resolveConsumable(def) : null;
  if (!consumable || !placed || !def) return null;

  const left = peelOne(placed);
  const spent = left
    ? stack.map((held, i) => (i === ref.stackIndex ? left : held))
    : stack.filter((_, i) => i !== ref.stackIndex);
  const eaten = { kind: "eaten" as const, consumable, name: def.name, equipment };

  const residue = residueOf(consumable, tilesById, mintId);
  if (!residue) return { ...eaten, map: replaceStack(map, ref.x, ref.y, ref.z, spent) };
  const next = stackWithItem(spent, placementFromInstance(residue), tilesById);
  if (!canReplaceStack(map, ref.x, ref.y, ref.z, next, tilesById).ok) {
    return { kind: "noRoom", residue: tilesById[residue.tileId]! };
  }
  return { ...eaten, map: replaceStack(map, ref.x, ref.y, ref.z, next) };
}

function consumeFromSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
  mintId: () => string,
): ConsumeOutcome | null {
  const instance = itemInSlot(map, tilesById, actor, equipment, slot);
  const def = instance && tilesById[instance.tileId];
  const consumable = def ? resolveConsumable(def) : null;
  if (!consumable || !def) return null;

  const emptied = peelSlot(map, tilesById, actor, equipment, slot);
  if (!emptied) return null;
  const eaten = { kind: "eaten" as const, consumable, name: def.name };

  const residue = residueOf(consumable, tilesById, mintId);
  if (!residue) return { ...eaten, ...emptied };
  const landed = leaveResidue(emptied.map, tilesById, actor, emptied.equipment, slot, residue);
  if (!landed) return { kind: "noRoom", residue: tilesById[residue.tileId]! };
  return { ...eaten, ...landed };
}
