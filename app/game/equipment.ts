import type { BattlerDef, FightingStats } from "../lib/battler";
import {
  bodyDefence,
  encumbered,
  encumbrance,
  fightingStats,
  NO_RESISTANCES,
} from "../lib/battler";
import type {
  ArcaneStoneItem,
  ArmorItem,
  ArmorSlot,
  CharmItem,
  ItemDef,
  ShieldItem,
  WeaponItem,
  WeaponResistances,
} from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import {
  ARMOR_SLOTS,
  armorSlotOf,
  isTwoHanded,
  itemElements,
  itemRequirements,
  NO_ELEMENTS,
  resolveArmor,
  resolveCharm,
  resolveContainer,
  resolveItem,
  resolveShield,
  resolveStone,
  resolveWeapon,
} from "../lib/item";
import { type Element, ELEMENTS } from "../lib/element";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import {
  type Masteries,
  meetsMagicRequirements,
  meetsRequirements,
  physicalShortfall,
  WEAPON_MASTERIES,
} from "../lib/mastery";
import { resolveLight } from "../lib/tileResolve";
import type { TileDef } from "../lib/types";

export type Equipment = {
  weapon: ItemInstance | null;
  offhand: ItemInstance | null;
  armor: ItemInstance | null;
  head: ItemInstance | null;
  charm: ItemInstance | null;
  footwear: ItemInstance | null;
  bag: ItemInstance | null;
};

export const HANDS = ["weapon", "offhand"] as const;

export type Hand = (typeof HANDS)[number];

export type Hands = Pick<Equipment, Hand>;

export function otherHand(hand: Hand): Hand {
  return hand === "weapon" ? "offhand" : "weapon";
}

export type { EquipSlot };

export function emptyEquipment(): Equipment {
  return Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [slot, null])) as Equipment;
}

export function restoredEquipment(saved: Equipment, tilesById: Record<string, TileDef>): Equipment {
  const weaponDef = saved.weapon ? tilesById[saved.weapon.tileId] : undefined;
  const weapon =
    saved.weapon && weaponDef && handAccepts(weaponDef)
      ? restoredInstance(saved.weapon, weaponDef)
      : null;

  const offhandDef = saved.offhand ? tilesById[saved.offhand.tileId] : undefined;
  const offhandHeld =
    saved.offhand && offhandDef && handAccepts(offhandDef)
      ? restoredInstance(saved.offhand, offhandDef)
      : null;

  const hands = { weapon, offhand: offhandHeld };
  const claimed = handClaimedByTwoHander(hands, tilesById);
  const offhand = claimed === "offhand" ? null : offhandHeld;
  if (claimed === "weapon") hands.weapon = null;

  const worn = {} as Record<ArmorSlot, ItemInstance | null>;
  for (const slot of ARMOR_SLOTS) {
    const instance = saved[slot];
    const def = instance ? tilesById[instance.tileId] : undefined;
    worn[slot] = instance && def && wornAccepts(slot, def) ? restoredInstance(instance, def) : null;
  }

  const bagDef = saved.bag ? tilesById[saved.bag.tileId] : undefined;
  const container = bagDef ? resolveContainer(bagDef) : null;
  if (!saved.bag || !container?.equippable) {
    return { ...worn, weapon: hands.weapon, offhand, bag: null };
  }

  const contents = (saved.bag.contents ?? [])
    .filter((instance) => {
      const def = tilesById[instance.tileId];
      return def != null && resolveItem(def) != null && !resolveContainer(def);
    })
    .slice(0, container.size)
    .map(identified);

  return {
    ...worn,
    weapon: hands.weapon,
    offhand,
    bag: { ...identified(saved.bag), contents },
  };
}

function identified(instance: ItemInstance): ItemInstance {
  return instance.id ? instance : { ...instance, id: mintItemId() };
}

function restoredInstance(instance: ItemInstance, def: TileDef): ItemInstance {
  const named = identified(instance);
  if (!named.cooldownMs) return named;
  const stone = resolveStone(def);
  if (!stone) {
    const { cooldownMs: _cooling, ...rest } = named;
    return rest;
  }
  const cooldownMs = Math.min(named.cooldownMs, stone.cooldownMs);
  return cooldownMs === named.cooldownMs ? named : { ...named, cooldownMs };
}

export const EQUIPMENT_SLOTS: readonly (keyof Equipment)[] = EQUIP_SLOTS;

const _everySlotIsListed: Record<Exclude<keyof Equipment, EquipSlot>, never> = {};

export function carriedInstances(equipment: Equipment): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const instance = equipment[slot];
    if (!instance) continue;
    out.push(instance);
    if (instance.contents) out.push(...instance.contents);
  }
  return out;
}

export function wornInstances(equipment: Equipment): ItemInstance[] {
  return EQUIPMENT_SLOTS.map((slot) => equipment[slot]).filter(
    (instance): instance is ItemInstance => instance != null,
  );
}

export function spilled(equipment: Equipment, tilesById: Record<string, TileDef>): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const instance = equipment[slot];
    if (!instance) continue;
    const def = tilesById[instance.tileId];
    if (slot === "bag" && def && resolveContainer(def)) {
      out.push(...(instance.contents ?? []));
      continue;
    }
    out.push(instance);
  }
  return out;
}

export function carriedLightTileIds(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
): string[] {
  const out: string[] = [];
  for (const instance of wornInstances(equipment)) {
    const def = tilesById[instance.tileId];
    if (!def) continue;
    if (resolveLight(def, { direction: instance.direction })) {
      out.push(instance.tileId);
    }
  }
  return out;
}

export function weaponInHand(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  hand: Hand | null,
): WeaponItem {
  if (!hand) return base.naturalWeapon;
  return weaponSwungBy(equipment, tilesById, hand, base.masteries) ?? base.naturalWeapon;
}

/**
 * A weapon short of its arcane or element requirements is held like a torch:
 * it swings nothing, so the body falls back on its natural weapon.
 */
export function weaponSwungBy(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  hand: Hand,
  masteries: Masteries,
): WeaponItem | null {
  const held = equipment?.[hand];
  if (!held) return null;
  const def = tilesById[held.tileId];
  if (!def || magicDormant(def, masteries)) return null;
  return resolveWeapon(def);
}

export function handToSwing(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  preferred: Hand,
  masteries: Masteries,
  usable?: (weapon: WeaponItem, hand: Hand) => boolean,
): Hand | null {
  for (const hand of [preferred, otherHand(preferred)]) {
    const weapon = weaponSwungBy(equipment, tilesById, hand, masteries);
    if (weapon && (!usable || usable(weapon, hand))) return hand;
  }
  return null;
}

export function fightsWithAHand(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): boolean {
  return HANDS.some((hand) => weaponSwungBy(equipment, tilesById, hand, masteries));
}

export function twoHandedHand(
  equipment: Hands | null,
  tilesById: Record<string, TileDef>,
): Hand | null {
  for (const hand of HANDS) {
    const held = equipment?.[hand];
    if (!held) continue;
    const def = tilesById[held.tileId];
    if (def && isTwoHanded(def)) return hand;
  }
  return null;
}

export function handClaimedByTwoHander(
  equipment: Hands | null,
  tilesById: Record<string, TileDef>,
): Hand | null {
  const holding = twoHandedHand(equipment, tilesById);
  return holding ? otherHand(holding) : null;
}

export function effectiveBattler(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  hand: Hand | null,
): FightingStats {
  const stats = encumbered(
    fightingStats(base, weaponInHand(base, equipment, tilesById, hand)),
    encumbrance(armorShortfall(base.masteries, equipment, tilesById)),
  );
  const guard = wornDefence(base, equipment, tilesById) + bodyDefence(base);
  const resist = armorResistances(equipment, tilesById, base.masteries);
  if (guard === stats.def && resist === NO_RESISTANCES) return stats;
  return { ...stats, def: guard, resist };
}

export function armorShortfall(
  masteries: Masteries,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): number {
  if (!equipment) return 0;
  let missing = 0;
  for (let i = 0; i < EQUIPMENT_SLOTS.length; i++) {
    const instance = equipment[EQUIPMENT_SLOTS[i]!];
    const def = instance ? tilesById[instance.tileId] : undefined;
    const item = def ? resolveItem(def) : null;
    if (!item || !isProtective(item)) continue;
    missing += physicalShortfall(masteries, item.requirements);
  }
  return missing;
}

function isProtective(item: ItemDef): item is ArmorItem | ShieldItem | CharmItem {
  return item.type === "armor" || item.type === "shield" || item.type === "charm";
}

export function magicDormant(def: TileDef, masteries: Masteries): boolean {
  return !meetsMagicRequirements(masteries, itemRequirements(def));
}

/**
 * Indexed rather than `for...of`, here and in `armorDefence`, `armorShortfall` and `physicalShortfall`:
 * Bun's JIT deoptimises a `for...of` whose body did not run while it was being compiled.
 */
export function armorResistances(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): WeaponResistances {
  let summed: WeaponResistances | null = null;
  const worn = wornArmor(equipment, tilesById, masteries);
  for (let i = 0; i < worn.length; i++) {
    const armor = worn[i]!;
    if (!armor.resist) continue;
    summed ??= {};
    for (const mastery of WEAPON_MASTERIES) {
      const against = armor.resist[mastery];
      if (against == null) continue;
      summed[mastery] = (summed[mastery] ?? 0) + against;
    }
  }
  return summed ?? NO_RESISTANCES;
}

export function bodyElements(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): readonly Element[] {
  const sources: (readonly Element[])[] = [base.elements ?? NO_ELEMENTS];
  if (equipment) {
    for (const instance of wornInstances(equipment)) {
      const def = tilesById[instance.tileId];
      if (def && !magicDormant(def, base.masteries)) sources.push(itemElements(def));
    }
  }

  if (sources.every((elements) => elements.length === 0)) return NO_ELEMENTS;
  return ELEMENTS.filter((element) => sources.some((elements) => elements.includes(element)));
}

export function wornDefence(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): number {
  return (
    heldDefence(equipment, tilesById, base.masteries) +
    natureDefence(base, equipment, tilesById) +
    armorDefence(equipment, tilesById, base.masteries)
  );
}

function natureDefence(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): number {
  return fightsWithAHand(equipment, tilesById, base.masteries) ? 0 : base.naturalWeapon.def;
}

export function armorDefence(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): number {
  const worn = wornArmor(equipment, tilesById, masteries);
  let total = 0;
  for (let i = 0; i < worn.length; i++) total += worn[i]!.def;
  return total;
}

function wornArmor(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): ArmorItem[] {
  if (!equipment) return [];
  const out: ArmorItem[] = [];
  for (const slot of ARMOR_SLOTS) {
    const instance = equipment[slot];
    if (!instance) continue;
    const def = tilesById[instance.tileId];
    const armor = def ? armorForSlot(slot, def) : null;
    if (armor && meetsMagicRequirements(masteries, armor.requirements)) out.push(armor);
  }
  return out;
}

export function armorForSlot(slot: ArmorSlot, def: TileDef): ArmorItem | null {
  const armor = resolveArmor(def);
  return armor && armorSlotOf(armor) === slot ? armor : null;
}

export function heldDefence(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): number {
  let total = 0;
  for (const hand of HANDS) {
    const held = equipment?.[hand];
    if (!held) continue;
    const def = tilesById[held.tileId];
    if (!def || magicDormant(def, masteries)) continue;
    total += resolveWeapon(def)?.def ?? resolveShield(def)?.def ?? 0;
  }
  return total;
}

export function handHasRoomFor(
  equipment: Hands | null,
  tilesById: Record<string, TileDef>,
  hand: Hand,
  def: TileDef,
): boolean {
  const other = otherHand(hand);
  if (twoHandedHand(equipment, tilesById) === other) return false;
  if (isTwoHanded(def)) return equipment?.[other] == null;
  return true;
}

export function handAccepts(def: TileDef): boolean {
  const item = resolveItem(def);
  if (!item) return false;
  if (resolveCharm(def)) return false;
  return item.type !== "container" || item.equippable;
}

export function wornAccepts(slot: ArmorSlot, def: TileDef): boolean {
  if (armorForSlot(slot, def)) return true;
  if (slot !== "charm") return false;
  if (resolveStone(def) != null || resolveCharm(def) != null) return true;
  return resolveLight(def) != null;
}

export function stoneIn(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
  slot: keyof Equipment,
): ArcaneStoneItem | null {
  const held = equipment?.[slot];
  if (!held) return null;
  const def = tilesById[held.tileId];
  return def ? resolveStone(def) : null;
}

export function stoneLocked(
  instance: ItemInstance | null,
  tilesById: Record<string, TileDef>,
): boolean {
  if (!instance?.cooldownMs) return false;
  const def = tilesById[instance.tileId];
  return def != null && resolveStone(def) != null;
}

export function takesEffect(
  slot: EquipSlot,
  instance: ItemInstance | null,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): boolean {
  if (!instance) return false;
  const def = tilesById[instance.tileId];
  if (!def) return false;
  if (magicDormant(def, masteries)) return false;

  if (itemElements(def).length > 0) return true;
  if (resolveLight(def, { direction: instance.direction })) return true;

  const stone = resolveStone(def);
  if (stone) return meetsRequirements(masteries, stone.requirements);

  if (slot === "weapon" || slot === "offhand") {
    return (
      resolveWeapon(def) != null || resolveShield(def) != null || resolveContainer(def) != null
    );
  }

  if (slot === "bag") return resolveContainer(def) != null;

  if (armorForSlot(slot, def)) return true;
  return slot === "charm" && resolveCharm(def) != null;
}
