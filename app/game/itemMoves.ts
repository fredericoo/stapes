import { getStack, replaceStack } from "../lib/mapData";
import type { ItemDef } from "../lib/item";
import { resolveContainer, resolveItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf, fuses, peelOne, pourInto, stow, stowFits, withCount } from "../lib/piles";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { equipSlotsFor, reachableItemDefAt, type Actor, type ObjectRef } from "./affordances";
import {
  type Equipment,
  type Hand,
  handAccepts,
  handHasRoomFor,
  stoneLocked,
  wornAccepts,
} from "./equipment";

export type SlotRef =
  | { kind: "weapon" }
  | { kind: "offhand" }
  | { kind: "armor" }
  | { kind: "head" }
  | { kind: "charm" }
  | { kind: "footwear" }
  | { kind: "bag" }
  | { kind: "contents"; index: number; of?: "weapon" | "offhand" }
  | { kind: "ground"; ref: ObjectRef; index: number };

export type ContainerRef =
  | { kind: "bag" }
  | { kind: "hand"; hand: "weapon" | "offhand" }
  | { kind: "ground"; ref: ObjectRef };

export type OpenedContainer = { instance: ItemInstance; ref: ObjectRef };

export function slotIn(container: ContainerRef, index: number): SlotRef {
  if (container.kind === "bag") return { kind: "contents", index };
  if (container.kind === "hand") {
    return { kind: "contents", index, of: container.hand };
  }
  return { kind: "ground", ref: container.ref, index };
}

function contentsHolder(slot: { of?: "weapon" | "offhand" }): "bag" | "weapon" | "offhand" {
  return slot.of ?? "bag";
}

const BODY_SLOT_KINDS: ReadonlySet<string> = new Set(EQUIP_SLOTS);

export type BodySlotRef = Extract<SlotRef, { kind: EquipSlot }>;

export function isBodySlot(slot: SlotRef): slot is BodySlotRef {
  return BODY_SLOT_KINDS.has(slot.kind);
}

export function slotKey(slot: SlotRef): string {
  if (isBodySlot(slot)) return slot.kind;
  if (slot.kind === "contents") {
    return `contents:${contentsHolder(slot)}:${slot.index}`;
  }
  const { x, y, z, stackIndex } = slot.ref;
  return `ground:${x},${y},${z},${stackIndex}:${slot.index}`;
}

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

export function capacityOf(instance: ItemInstance, tilesById: Record<string, TileDef>): number {
  const def = tilesById[instance.tileId];
  return def ? (resolveContainer(def)?.size ?? 0) : 0;
}

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

export type SlotKind = SlotRef["kind"];

export function slotAccepts(
  kind: SlotKind,
  instance: ItemInstance,
  tilesById: Record<string, TileDef>,
): boolean {
  const def = tilesById[instance.tileId];
  return def != null && slotTakes(kind, def);
}

export function slotTakes(kind: SlotKind, def: TileDef): boolean {
  if (kind === "weapon" || kind === "offhand") return handAccepts(def);
  if (kind === "bag") return resolveContainer(def)?.equippable === true;
  if (kind === "contents" || kind === "ground") {
    return resolveContainer(def) == null;
  }
  return wornAccepts(kind, def);
}

function isHand(kind: SlotKind): kind is Hand {
  return kind === "weapon" || kind === "offhand";
}

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
    return stowFits(holder.contents ?? [], instance, capacityOf(holder, tilesById), tilesById);
  }
  const placed = groundContainerAt(map, tilesById, actor, slot.ref);
  if (!placed) return false;
  const def = tilesById[placed.tileId];
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  return stowFits(placed.contents ?? [], instance, size, tilesById);
}

export function bodySlotHasRoom(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  kind: EquipSlot,
  instance: ItemInstance,
): boolean {
  const held = equipment[kind];
  if (held) return fuses(held, instance, tilesById);
  const def = tilesById[instance.tileId];
  return isHand(kind) && def ? handHasRoomFor(equipment, tilesById, kind, def) : true;
}

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
  if (!held || fuses(held, instance, tilesById)) return NOTHING_TO_DISPLACE;
  const def = tilesById[held.tileId];
  const item = def ? resolveItem(def) : null;
  if (!item) return SOMETHING_ELSE_HELD;
  if (item.type === incoming.type) return THE_SAME_KIND;
  if (item.type === "weapon") return A_WEAPON;
  if (item.type === "armor" || item.type === "charm") return SOMETHING_WORN;
  return SOMETHING_ELSE_HELD;
}

function squareCouldTake(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  kind: EquipSlot,
  homes: readonly EquipSlot[],
  instance: ItemInstance,
  def: TileDef,
): boolean {
  if (!slotTakes(kind, def)) return false;
  if (isHand(kind) && !homes.some(isHand)) return false;
  if (bodySlotHasRoom(equipment, tilesById, kind, instance)) return true;
  if (!equipment[kind]) return false;
  const emptied: Equipment = { ...equipment, [kind]: null };
  return bodySlotHasRoom(emptied, tilesById, kind, instance);
}

export function equipDestination(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  instance: ItemInstance,
  lands: (to: BodySlotRef) => boolean = () => true,
): BodySlotRef | null {
  const def = tilesById[instance.tileId];
  const item = def ? resolveItem(def) : null;
  const homes = def ? equipSlotsFor(def) : [];
  const home = homes[0];
  if (!def || !item || !home) return null;

  const ranked = EQUIP_SLOTS.filter((kind) =>
    squareCouldTake(equipment, tilesById, kind, homes, instance, def),
  )
    .map((kind) => ({
      kind,
      cost: displacementCost(equipment[kind], item, instance, tilesById),
      belongs: belongsRank(homes, kind),
    }))
    .sort((a, b) => a.cost - b.cost || a.belongs - b.belongs);

  for (const { kind } of ranked) {
    if (lands({ kind })) return { kind };
  }
  return { kind: home };
}

function belongsRank(homes: readonly EquipSlot[], kind: EquipSlot): number {
  const at = homes.indexOf(kind);
  return at === -1 ? homes.length : at;
}

function withGroundContents(map: MapFile, ref: ObjectRef, contents: ItemInstance[]): MapFile {
  const stack = getStack(map, ref.x, ref.y, ref.z);
  const next = stack.map((placed, i) => (i === ref.stackIndex ? { ...placed, contents } : placed));
  return replaceStack(map, ref.x, ref.y, ref.z, next);
}

export function stashInContainer(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ref: ObjectRef,
  instance: ItemInstance,
): MapFile | null {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return null;
  const contents = placed.contents ?? [];
  return withGroundContents(
    map,
    ref,
    pourInto(contents, instance, tilesById) ?? [...contents, instance],
  );
}

export type ItemMoveResult = { map: MapFile; equipment: Equipment };

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
  if (!instance.id) return null;
  if (stoneLocked(instance, tilesById)) return null;
  if (!slotAccepts(to.kind, instance, tilesById)) return null;
  if (!slotHasRoom(map, tilesById, actor, equipment, to, instance)) {
    return isBodySlot(to) ? swapInto(map, tilesById, actor, equipment, from, to, instance) : null;
  }

  const emptied = clearSlot(map, tilesById, actor, equipment, from);
  if (!emptied) return null;
  return fillSlot(emptied.map, tilesById, actor, emptied.equipment, to, instance);
}

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
  if (!displaced?.id) return null;
  if (displaced.tileId === instance.tileId && countOf(displaced) + countOf(instance) > 2) {
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
  const filled = fillSlot(both.map, tilesById, actor, both.equipment, to, instance);
  if (!filled) return null;

  if (!slotHasRoom(filled.map, tilesById, actor, filled.equipment, from, displaced)) {
    return null;
  }
  return fillSlot(filled.map, tilesById, actor, filled.equipment, from, displaced);
}

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
    map: withGroundContents(map, slot.ref, replaceAt(contents, slot.index, left)),
    equipment,
  };
}

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

function fillSlot(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  slot: SlotRef,
  instance: ItemInstance,
): ItemMoveResult | null {
  if (isBodySlot(slot)) {
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

function removeAt(contents: ItemInstance[], index: number): ItemInstance[] {
  return contents.filter((_, i) => i !== index);
}

function replaceAt(
  contents: readonly ItemInstance[],
  index: number,
  instance: ItemInstance,
): ItemInstance[] {
  return contents.map((held, i) => (i === index ? instance : held));
}
