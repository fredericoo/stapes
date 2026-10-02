import { damageBand, swingIntervalMs } from "../app/game/combat";
import { carriedInstances, magicDormant, type Equipment } from "../app/game/equipment";
import type { EquipSlot } from "../app/game/affordances";
import { fightingStats, encumbrance, resolveBattler, type BattlerDef } from "../app/lib/battler";
import {
  armorSlotOf,
  isRanged,
  isTwoHanded,
  reachOf,
  resolveItem,
  resolveStone,
  resolveWeapon,
  type Reach,
  type WeaponItem,
} from "../app/lib/item";
import {
  hasExperience,
  masteriesFromXp,
  physicalShortfall,
  type Masteries,
  type MasteryXp,
  type WeaponMastery,
} from "../app/lib/mastery";
import type { StatusDef } from "../app/lib/status";
import { resolveLight } from "../app/lib/tileResolve";
import type { TileDef } from "../app/lib/types";
import { boltDamage, LIGHT_WORTH, stoneWorth, usableStone } from "./arcane";

/**
 * The weapon mastery a bot means to grow, and so the weapons it buys. An
 * arcane bot holds a stone in its off hand and a weapon of any kind in the
 * other, until it carries a bolt for each hand (`stoneHanded`).
 */
export type Style = Extract<WeaponMastery, "sharp" | "blunt" | "ranged" | "arcane">;

export const STYLES: readonly Style[] = ["sharp", "blunt", "ranged", "arcane"];

/** What a bot judges gear by: the mastery it grows, and the statuses a stone may grant. */
export type Taste = {
  readonly style: Style;
  readonly statusDefs: Record<string, StatusDef>;
};

/**
 * A weapon of another mastery is worth this share of what it does. Mastery
 * grows with use, so a bot that bought whatever hit hardest today would never
 * grow any one of them. A new character does about 1.4 a second with the
 * simple bow and 2.9 with a rusty sword, so an archer
 * needs at least this much of a lean to take up the bow.
 */
export const OFF_STYLE_SHARE = 0.3;

/**
 * Armour short of its physical requirements still guards but slows the
 * wearer (`encumbrance`). Speed is what a bot runs and kites with, so the
 * slowing is counted at this many times what it takes off.
 */
export const ENCUMBRANCE_WEIGHT = 2;

/**
 * The squares a bot buys for and swaps in. The charm square is kept for a
 * light or a stone (`gearSlots`), so the armourer's amulets are never bought.
 */
export const GEAR_SLOTS: readonly EquipSlot[] = [
  "weapon",
  "offhand",
  "armor",
  "head",
  "footwear",
  "bag",
];

/**
 * A square of bag counts as much as a point of defence. The basic bag holds
 * four things, and money, skins, food and a spare light fill it.
 */
export const BAG_SQUARE_WORTH = 1;

/**
 * The bot's body as the server reckons it: the player tile's battler with
 * masteries read from the experience the server sent.
 */
export function bodyOf(tilesById: Record<string, TileDef>, xp: MasteryXp): BattlerDef | null {
  const def = tilesById.player;
  const authored = def ? resolveBattler(def) : null;
  if (!authored) return null;
  const masteries: Masteries = hasExperience(xp) ? masteriesFromXp(xp) : authored.masteries;
  return { ...authored, masteries };
}

/** An arcane bot puts down its weapon once it carries this many bolts, one for each hand. */
export const BOLTS_FOR_BOTH_HANDS = 2;

/**
 * Whether the bot's hands are both for stones: an arcane bot carrying
 * `BOLTS_FOR_BOTH_HANDS` bolts it can cast. Before that one hand swings a
 * weapon, because a single bolt cooling between casts leaves a caster with
 * nothing but fists.
 */
export function stoneHanded(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  taste: Taste,
  masteries: Masteries,
): boolean {
  if (taste.style !== "arcane") return false;
  const bolts = carriedInstances(equipment).filter((instance) => {
    const stone = usableStone(tilesById[instance.tileId], masteries);
    return stone !== null && boltDamage(stone, masteries) > 0;
  });
  return bolts.length >= BOLTS_FOR_BOTH_HANDS;
}

/**
 * What swinging `weapon` in the weapon hand is worth. An arcane bot takes
 * whatever hits hardest while it still swings one, because it means to put
 * it down; once it is `stoneHanded`, a weapon is worth nothing there, or a
 * new caster's sword would outweigh its first bolts for ever.
 */
function swingWorth(
  weapon: WeaponItem,
  body: BattlerDef,
  taste: Taste,
  stoneHands: boolean,
): number {
  if (stoneHands) return 0;
  const style = taste.style === "arcane" ? weapon.mastery : taste.style;
  return weaponWorth(weapon, body, style);
}

/** Expected damage a second, the same figures the stats panel reads. */
export function weaponWorth(weapon: WeaponItem, body: BattlerDef, style: WeaponMastery): number {
  const stats = fightingStats(body, weapon);
  const band = damageBand(stats);
  const perSecond = (((band.min + band.max) / 2) * stats.hitChance * 1000) / swingIntervalMs(stats);
  return weapon.mastery === style ? perSecond : perSecond * OFF_STYLE_SHARE;
}

/**
 * What one item is worth to the bot in the square it would go in: damage a
 * second for a weapon or a stone, defence for armour and shields, room for a
 * bag, a light's worth for a light in the charm square, and nothing for
 * anything else. Magic gear the bot cannot wake is worth nothing.
 */
export function gearWorth(
  def: TileDef,
  slot: EquipSlot,
  body: BattlerDef,
  taste: Taste,
  stoneHands: boolean,
): number {
  if (magicDormant(def, body.masteries)) return 0;
  const item = resolveItem(def);
  if (!item) return 0;
  const { style } = taste;
  if (item.type === "stone") {
    return gearSlots(def, style, stoneHands).includes(slot)
      ? stoneWorth(def, body.masteries, taste.statusDefs)
      : 0;
  }
  if (slot === "charm" && resolveLight(def, {}) !== undefined) return LIGHT_WORTH;
  if (item.type === "weapon" && slot === "weapon") {
    return swingWorth(item, body, taste, stoneHands);
  }
  if (item.type === "weapon" && slot === "offhand" && isSidearm(item, style)) {
    return weaponWorth(item, body, item.mastery as Style) * SIDEARM_SHARE;
  }
  if (item.type === "container" && slot === "bag") return item.size * BAG_SQUARE_WORTH;
  if (item.type === "shield" && slot === "offhand") {
    return item.def * kept(physicalShortfall(body.masteries, item.requirements));
  }
  if (item.type === "armor" && armorSlotOf(item) === slot) {
    const resist = Object.values(item.resist ?? {}).reduce((sum, value) => sum + value, 0);
    const guard = item.def + resist / 4;
    return guard * kept(physicalShortfall(body.masteries, item.requirements));
  }
  return 0;
}

/**
 * An archer's off hand holds a blade or a club rather than a shield. A bow
 * cannot shoot inside its `Reach.min`, and `handToSwing` passes to the hand
 * that can reach, so the sidearm is what answers a rat or a wolf that is
 * faster than the bot and could not be kept at a distance.
 */
export const SIDEARM_SHARE = 0.5;

function isSidearm(weapon: WeaponItem, style: Style): boolean {
  return style === "ranged" && !isRanged(weapon) && weapon.mastery !== "arcane";
}

function kept(shortfall: number): number {
  return Math.max(0, 1 - ENCUMBRANCE_WEIGHT * encumbrance(shortfall));
}

/**
 * The squares a bot might put `def` in, if it is gear it buys for at all. An
 * arcane bot's off hand is for a stone, so it never takes up a shield.
 */
export function gearSlots(def: TileDef, style: Style, stoneHands: boolean): EquipSlot[] {
  if (resolveStone(def)) {
    if (style !== "arcane") return ["charm"];
    return stoneHands ? ["weapon", "offhand", "charm"] : ["offhand", "charm"];
  }
  const item = resolveItem(def);
  if (item?.type === "weapon") {
    return isSidearm(item, style) && !isTwoHanded(def) ? ["weapon", "offhand"] : ["weapon"];
  }
  if (item?.type === "shield") return style === "arcane" ? [] : ["offhand"];
  if (item?.type === "container") return item.equippable ? ["bag"] : [];
  if (item?.type !== "armor") return [];
  const slot = armorSlotOf(item);
  return GEAR_SLOTS.includes(slot) ? [slot] : [];
}

export type Upgrade = { readonly slot: EquipSlot; readonly gain: number };

/**
 * The square where `def` would help the bot most, and by how much it would
 * fight better with it there than as it is. An empty weapon hand is bare
 * hands; a two-handed weapon gives up whatever the off hand is worth too.
 * A piece already worn in `heldIn` gives up what it does there to move, or a
 * sword an archer could hold in either hand would swap hands for ever.
 */
export function bestUpgrade(
  def: TileDef,
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  body: BattlerDef,
  taste: Taste,
  heldIn: EquipSlot | null = null,
): Upgrade | null {
  const stoneHands = stoneHanded(equipment, tilesById, taste, body.masteries);
  const fists = body.naturalWeapon;
  const worthOf = (tileId: string | undefined, at: EquipSlot) => {
    const held = tileId ? tilesById[tileId] : undefined;
    if (held) return gearWorth(held, at, body, taste, stoneHands);
    if (at !== "weapon") return 0;
    return swingWorth(fists, body, taste, stoneHands);
  };
  const worth = (at: EquipSlot) => gearWorth(def, at, body, taste, stoneHands);
  const leaving = heldIn ? worth(heldIn) - worthOf(undefined, heldIn) : 0;
  let best: Upgrade | null = null;
  for (const slot of gearSlots(def, taste.style, stoneHands)) {
    if (slot === heldIn) continue;
    let gain = worth(slot) - worthOf(equipment[slot]?.tileId, slot) - leaving;
    if (slot === "weapon" && isTwoHanded(def)) {
      gain -= worthOf(equipment.offhand?.tileId, "offhand");
    }
    if (!best || gain > best.gain) best = { slot, gain };
  }
  return best;
}

/** The reach of the ranged weapon the bot swings, or null when it fights up close. */
export function rangedReach(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): Reach | null {
  for (const hand of ["weapon", "offhand"] as const) {
    const held = equipment[hand];
    const def = held ? tilesById[held.tileId] : undefined;
    if (!def || magicDormant(def, masteries)) continue;
    const weapon = resolveWeapon(def);
    if (weapon && isRanged(weapon)) return reachOf(weapon);
  }
  return null;
}
