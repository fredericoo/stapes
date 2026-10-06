import {
  instanceFromPlacement,
  placementFromInstance,
  type ItemInstance,
} from "../lib/itemInstance";
import { getStack, removeTileAt } from "../lib/mapData";
import { appendItem, stow } from "../lib/piles";
import type { Coord, MapFile, TileDef } from "../lib/types";
import {
  dropDestinationAt,
  equipSlotFrom,
  pickUpDestination,
  type Actor,
  type ObjectRef,
} from "./affordances";
import { stoneLocked, type Equipment } from "./equipment";
import {
  capacityOf,
  clearSlot,
  itemInSlot,
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
