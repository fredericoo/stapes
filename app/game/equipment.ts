import type { BattlerDef, FightingStats } from "../lib/battler";
import { bodyDefence, fightingStats, NO_RESISTANCES } from "../lib/battler";
import type {
  ArmorItem,
  ArmorSlot,
  WeaponItem,
  WeaponResistances,
} from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import {
  ARMOR_SLOTS,
  armorSlotOf,
  resolveArmor,
  resolveContainer,
  resolveItem,
  resolveWeapon,
} from "../lib/item";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import { WEAPON_MASTERIES } from "../lib/mastery";
import { resolveLight } from "../lib/tileResolve";
import type { TileDef } from "../lib/types";

/**
 * What carrying things does to a fight.
 *
 * Pure, and in `app/game/` beside `combat.ts` rather than in `app/lib/`, because
 * this is a rule of a fight rather than a shape on disk. Both ends read it: the
 * simulation to roll with, and the Item tab to say what a weapon is worth
 * without re-deriving the arithmetic beside it.
 */

/**
 * What an actor is carrying.
 *
 * On the runtime rather than on the placement, on exactly the terms hit points
 * are: `PlacedTile` changes broadcast themselves through cell patches, and a
 * cell patch invalidates light chunks and rebuilds level geometry. Equipping a
 * sword would dirty every chunk around the player for a change nothing in the
 * world can see.
 *
 * The bag slot holds an instance like any other, and **the inventory is that
 * instance's `contents`** — not a second array beside it. One thing in one
 * place, whether it is on somebody's back or lying on the floor, which is what
 * makes dropping a full bag drop what is in it without anything having to
 * arrange that.
 */
export type Equipment = {
  weapon: ItemInstance | null;
  /**
   * The other hand — a torch, a shield, whatever is worth carrying that is not
   * what you are swinging.
   *
   * **It exists because the weapon slot was the only hand there was, and a
   * held weapon replaces your fists rather than adding to them.** So a lantern,
   * which is authored as a weapon because it had to go somewhere, meant fighting
   * at a twentieth of your bare hands to see in the dark. That is a real
   * trade-off to offer a player and a terrible one to impose on them without
   * saying so, and the honest fix is a second hand rather than a warning label.
   *
   * It does not swing. What reaches a fight from here is light and defence —
   * see {@link carriedLightTileIds} and {@link effectiveBattler} — which is
   * exactly what a torch and a shield are for.
   */
  offhand: ItemInstance | null;
  /**
   * What is worn on the body — a tunic, a mail shirt, a breastplate.
   *
   * The first of the four squares that take exactly one kind of thing, and the
   * strictness is the point. Both hands are deliberately generous because a hand
   * *is* generous — you can hold a backpack if you would rather — but there is
   * no honest reading of a body under which a sword or a loaf of bread is what
   * you are wearing. So `slotTakes` refuses everything that is not an
   * {@link ArmorItem} *for this square* here, and that refusal is what makes it
   * legible: whatever is in it is protecting you, and the number it is worth is
   * the whole of what it does.
   *
   * It adds to whatever is in either hand rather than replacing it — see
   * {@link wornDefence}. A shield and a mail shirt are two different answers to
   * being hit, and a body with both should get both.
   */
  armor: ItemInstance | null;
  /**
   * What is on the head — a cap, a helm, a crown.
   *
   * One of the four squares that take {@link ArmorItem} and nothing else, and
   * the one that decides which is the armour's own `slot` — see `../lib/item`'s
   * {@link ARMOR_SLOTS}. Everything the body square does, this does: it adds to
   * whatever else is worn rather than replacing it, and its `def` and `resist`
   * reach a fight through {@link wornDefence} and {@link armorResistances}.
   */
  head: ItemInstance | null;
  /**
   * What is round the neck or on a finger — a ring, an amulet, a charm.
   *
   * Armour, on the same terms a helmet is, and the fact that it is not obviously
   * *armour* is the point of having a square for it: a thing that turns a blow
   * aside without being a plate is how an author writes a warding trinket, and
   * the alternative — a fifth kind of item with its own arithmetic — would be a
   * second answer to the question `def` already answers.
   */
  charm: ItemInstance | null;
  /**
   * What is on the feet — boots, shoes, sabatons.
   *
   * The last of the worn squares, and it does exactly what the other three do.
   * There is deliberately nothing about *movement* here: how fast a body gets
   * about is a fact about the body, and a boot that changed it would be a second
   * stat block arguing with the weapon's, which is the thing the whole item
   * model exists to avoid.
   */
  footwear: ItemInstance | null;
  /** An equippable container. Its `contents` is the inventory. */
  bag: ItemInstance | null;
};

/**
 * Which slot a thing is worn in.
 *
 * Named in `../lib/kit` rather than here, because an authored kit has to say
 * one and `lib` may not reach into `game`. {@link EQUIPMENT_SLOTS} below is what
 * holds the two shapes together.
 */
export type { EquipSlot };

/**
 * Carrying nothing at all — a body that was never given a kit.
 *
 * Built from {@link EQUIPMENT_SLOTS} rather than written out, so a square added
 * to the game arrives here empty on its own. A hand-written literal is how a
 * body would come to be born missing a slot it has.
 */
export function emptyEquipment(): Equipment {
  return Object.fromEntries(
    EQUIPMENT_SLOTS.map((slot) => [slot, null]),
  ) as Equipment;
}

/**
 * A kit handed back by the world's memory, checked against the world as it is
 * now.
 *
 * The same terms a remembered *position* is honoured on: it is a wish, and the
 * board decides. A position is offered to `findEntryCell`, which declines it if
 * somebody has built there since; a kit is offered here, and every part of it
 * that the tile catalogue no longer agrees with is dropped.
 *
 * What can have changed while somebody was away is the authored content: a tile
 * renamed, a sword made into a prop, a bag shrunk. None of those are corruption
 * and none should refuse a returning player their world — they are simply facts
 * the memory is out of date about.
 *
 * Never a throw and never a null: the worst case is somebody comes back with
 * nothing, which is where they started.
 */
export function restoredEquipment(
  saved: Equipment,
  tilesById: Record<string, TileDef>,
): Equipment {
  // Both hands asked the same question, because both hands *are* the same
  // question now — see {@link handAccepts}.
  const weaponDef = saved.weapon ? tilesById[saved.weapon.tileId] : undefined;
  const weapon =
    saved.weapon && weaponDef && handAccepts(weaponDef)
      ? identified(saved.weapon)
      : null;

  // Absent on a kit saved before this slot existed, which reads as an empty
  // hand — the same answer the rest of this function gives to anything the world
  // no longer agrees with.
  const offhandDef = saved.offhand ? tilesById[saved.offhand.tileId] : undefined;
  const offhand =
    saved.offhand && offhandDef && handAccepts(offhandDef)
      ? identified(saved.offhand)
      : null;

  // Held to what the *square* takes rather than to what a hand takes, because
  // these are the strict ones — a sword that was armour while somebody was away
  // comes back off their chest rather than staying on it, and a helm an author
  // moved to the feet comes off the head rather than staying above it.
  const worn = {} as Record<ArmorSlot, ItemInstance | null>;
  for (const slot of ARMOR_SLOTS) {
    // Absent on a kit saved before this square existed, which reads as an empty
    // one — the same answer the rest of this function gives to anything the
    // world no longer agrees with.
    const instance = saved[slot];
    const def = instance ? tilesById[instance.tileId] : undefined;
    worn[slot] =
      instance && def && armorForSlot(slot, def) ? identified(instance) : null;
  }

  const bagDef = saved.bag ? tilesById[saved.bag.tileId] : undefined;
  const container = bagDef ? resolveContainer(bagDef) : null;
  if (!saved.bag || !container?.equippable) {
    return { ...worn, weapon, offhand, bag: null };
  }

  // Truncated to what the bag holds *now*, because an author who shrank it did
  // so knowing what was in the world — and a bag reporting 6/4 is a state no
  // capacity check downstream has an answer for.
  const contents = (saved.bag.contents ?? [])
    .filter((instance) => {
      const def = tilesById[instance.tileId];
      // Not a container, on the nesting rule: a chest that became equippable
      // while somebody was away must not come back inside their backpack.
      return def != null && resolveItem(def) != null && !resolveContainer(def);
    })
    .slice(0, container.size)
    .map(identified);

  return {
    ...worn,
    weapon,
    offhand,
    bag: { ...identified(saved.bag), contents },
  };
}

/**
 * The same thing, certain to have a name to be called by.
 *
 * A repair rather than a rule, and it exists because a kit outlives the code
 * that wrote it. An instance with no id is a thing the wire cannot describe —
 * `id` is required in the protocol's schema, so one saved kit carrying an
 * anonymous item is a `hello` that fails to parse and a player who can never
 * finish joining again. Storage is the one place a shape from an older build
 * arrives from, so it is the one place worth being suspicious in.
 *
 * Minted rather than dropped, on the terms the rest of this function restores
 * on: what is wrong here is the bookkeeping, not the sword, and somebody coming
 * back should find their sword.
 */
function identified(instance: ItemInstance): ItemInstance {
  return instance.id ? instance : { ...instance, id: mintItemId() };
}

/**
 * Every slot on a body, in the order they are reached for.
 *
 * Written down once, because "the fields of `Equipment`" is a list two separate
 * passes had already got out of step with each other — the off hand was the
 * first slot added and the second one to be forgotten somewhere. It is now the
 * *authored* list — an author names a slot in a kit, so `../lib/kit` had to own
 * the names — and this is where the runtime shape is held to it.
 */
export const EQUIPMENT_SLOTS: readonly (keyof Equipment)[] = EQUIP_SLOTS;

/**
 * A slot added to {@link Equipment} and not to `EQUIP_SLOTS` would be a thing
 * carried that nothing here can see — no light read off it, no id minted for
 * what is inside it, nothing dropped when its owner dies. This is what makes
 * that a type error rather than a bug found a fortnight later: the record is
 * satisfiable by `{}` only while there is no such slot.
 */
const _everySlotIsListed: Record<Exclude<keyof Equipment, EquipSlot>, never> =
  {};

/** Everything worn or carried, slots and their contents alike, in a flat list. */
export function carriedInstances(equipment: Equipment): ItemInstance[] {
  const out: ItemInstance[] = [];
  // Every slot, and what is inside whatever is in it. A hand takes a spare pack
  // now, so the bag on your back is no longer the only thing on a body with
  // things inside it — and something missed here is something the id minting
  // pass never reaches, which is a thing the wire cannot describe.
  for (const slot of EQUIPMENT_SLOTS) {
    const instance = equipment[slot];
    if (!instance) continue;
    out.push(instance);
    // One level, never recursive: a container may not hold a container, so
    // there is nothing below this to walk.
    if (instance.contents) out.push(...instance.contents);
  }
  return out;
}

/**
 * Everything worn in a slot — what a light is read off, and what a death puts
 * on the floor.
 *
 * Deliberately *not* {@link carriedInstances}: what is in the bag is in the bag,
 * and it goes down with the bag rather than beside it.
 *
 * The list is over the slots rather than over the fields by name — the off hand
 * was the first of the "more of them" this comment anticipated, and adding it
 * was one entry here rather than a hunt through everything that lights a room.
 * `GameSession.dropKit` and the server's what-do-they-still-own test read it for
 * exactly that reason: both were a hand-written `[weapon, offhand, bag]`, which
 * is the shape the off hand has already been left out of once.
 */
export function wornInstances(equipment: Equipment): ItemInstance[] {
  return EQUIPMENT_SLOTS.map((slot) => equipment[slot]).filter(
    (instance): instance is ItemInstance => instance != null,
  );
}

/**
 * The tiles of the things this actor is *wearing* that give off light.
 *
 * A projection of {@link Equipment} rather than a second thing to keep in step,
 * and tile ids rather than `LightDef`s because every client already holds the
 * tile catalogue — sending the resolved lights would be sending what the
 * receiver can already look up.
 *
 * **Slots only, and the bag's contents are not slots.** A lantern lights the
 * room when you are holding it and not when it is buried in your pack, which is
 * both what a player expects and what makes a lantern worth a slot at all: with
 * a bag counting, carrying one cost nothing and there was no decision in it. The
 * bag *itself* counts, because it is worn — a glowing pack glows.
 *
 * Why this exists at all: an actor's own light never enters the static bake —
 * `GameRenderer` paints it as a dynamic emitter every frame, which is precisely
 * what stops a walking player from dirtying the chunks they cross. A carried
 * torch is the same problem and takes the same path, so equipping one costs a
 * dynamic paint rather than a rebake. Summing is the cast's own business: N
 * lights at one position is N emitters, and `castEmitter` already accumulates.
 *
 * Nothing consumes this yet. It is written and asserted now because it is a
 * pure function of the equipment shape, and getting that shape wrong is the
 * expensive half to discover later.
 */
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

/**
 * The weapon a body will actually swing: what is in its hand, or what it was
 * born with.
 *
 * **A held weapon replaces the natural one rather than adding to it**, and that
 * replacement is the whole rule. It used to be a sum — a sword was `+3 atk,
 * -10 spd` on top of whatever the tile already said — and the sum had to go for
 * masteries to work at all. If a body carries a full stat block of its own, a
 * mastery can only be a third modifier stacked on the other two, and the
 * authored numbers and the earned ones end up arguing over the same ground. Now
 * the body contributes what it is *good at* and the weapon contributes what it
 * *is*, and neither has an opinion about the other's job.
 *
 * Falling back to the natural weapon rather than to nothing is what makes the
 * empty hand an ordinary case instead of a special one: bare hands are a weapon,
 * a bite is a weapon, and nothing downstream has to ask which it got.
 *
 * A tile that has been renamed or turned into a prop while somebody was holding
 * it reads as an empty hand, on the terms {@link restoredEquipment} restores on:
 * the fact is out of date, not corrupt.
 */
export function weaponInHand(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): WeaponItem {
  const held = equipment?.weapon;
  if (!held) return base.naturalWeapon;
  const def = tilesById[held.tileId];
  return (def ? resolveWeapon(def) : null) ?? base.naturalWeapon;
}

/**
 * The numbers a body fights with, given what it is wearing.
 *
 * The one entry point the simulation uses, so there is a single place where
 * "these are the numbers" is answered — see `GameSession.battlerOf`, which
 * funnels the swing, the cooldown and the health bar's maximum through it.
 */
export function effectiveBattler(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): FightingStats {
  const stats = fightingStats(base, weaponInHand(base, equipment, tilesById));
  // Assigned rather than added to what `fightingStats` worked out, because
  // {@link wornDefence} has already counted that: the weapon in hand is one of
  // its three sources. Adding here is exactly the double count that splitting
  // defence across two functions used to invite — and did.
  // Everything worn, plus what the body turns aside on its own — see
  // `../lib/battler`'s {@link bodyDefence}. Toughness's share is the one part of
  // defence `wornDefence` does not count, so it is the one part that has to
  // survive the assignment below.
  const guard = wornDefence(base, equipment, tilesById) + bodyDefence(base);
  const resist = armorResistances(equipment, tilesById);
  if (guard === stats.def && resist === NO_RESISTANCES) return stats;
  return { ...stats, def: guard, resist };
}

/**
 * What everything worn on this body turns aside *extra*, kind by kind.
 *
 * **Summed across the armour squares, exactly as the flat half is**, and it did
 * not use to be: when the chest was the only place armour went, "one armour, one
 * table" was the same sentence as "the armour's table". It is not any more, and
 * a helm that shrugs off hammers beside a shirt that shrugs off blades should
 * do both — the alternative is one square silently deciding what the other three
 * are worth.
 *
 * Neither hand is counted, and that stays true: what a shield stops is a `def`,
 * and it has no opinion about what *kind* of blow it stopped. See
 * {@link wornDefence}, which is where the flat halves meet.
 *
 * Shared-empty for a bare body and for the overwhelmingly common armour that
 * says nothing — see {@link NO_RESISTANCES} — so `effectiveBattler` can tell
 * "nothing to add" by identity and hand back the stats it was given.
 */
export function armorResistances(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): WeaponResistances {
  let summed: WeaponResistances | null = null;
  for (const armor of wornArmor(equipment, tilesById)) {
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

/**
 * Everything this body has between it and a blow, added up.
 *
 * **Three sources and they sum**: what you are swinging, what you are holding
 * up, and what you have on — the last of which is itself the sum of the four
 * worn squares, see {@link armorDefence}. A sword with a `def` is a parrying
 * sword and a shield in your fist is a shield, so the main hand counts on
 * exactly the terms the others do — a body with a shield in each hand is
 * protected twice, and one wearing a helm and mail behind them twice more.
 * There is deliberately no cap and no diminishing return: the numbers an author
 * writes are the numbers, on the terms a weapon's damage is, and a ceiling
 * imposed here would be balance hiding in a helper.
 *
 * **The main hand replaces rather than adds, and only within its own slot.**
 * What is counted is {@link weaponInHand} — the held weapon, or the body's
 * natural one — so taking up a shield trades your claws' `def` for the shield's,
 * along with trading your bite for whatever the shield swings like. That is the
 * same replacement rule the swing itself is under, and it is what makes a shield
 * in the main hand a decision rather than three free points.
 *
 * **This was already the arithmetic; it was not in one place.** The main hand's
 * `def` reached a fight through `fightingStats`, which resolves the weapon,
 * while the other two were summed here — so "how protected is this body" had two
 * answers and neither function's name admitted it. The comment on
 * `WeaponItem.def` confidently said a main-hand `def` did nothing, which was
 * false the day it was written. It is one function now, and `effectiveBattler`
 * *assigns* what this returns rather than adding to it.
 *
 * Takes the body for the same reason {@link weaponInHand} does: bare hands are a
 * weapon, and what an empty fist turns aside is a fact about whose fist it is.
 */
export function wornDefence(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): number {
  return (
    weaponInHand(base, equipment, tilesById).def +
    offhandDefence(equipment, tilesById) +
    armorDefence(equipment, tilesById)
  );
}

/**
 * What everything worn on this body turns aside, added up.
 *
 * The four armour squares and nothing else — a head, a chest, a charm and a
 * pair of boots. Each takes armour and nothing else, and only armour *for that
 * square* — see {@link armorForSlot} — so unlike the off hand there is no "and
 * anything else with an opinion about defence" to allow for: whatever is in a
 * square is armour, and its `def` is the entirety of what it does.
 *
 * **They sum, with no cap and no diminishing return**, on exactly the terms the
 * three sources in {@link wornDefence} do. A body in a helm, mail and boots is
 * protected by all three, which is the whole reason to have squares for them;
 * the numbers an author writes are the numbers, and a ceiling imposed here would
 * be balance hiding in a helper.
 *
 * Zero for a bare body and for a tile the catalogue has lost, on the terms every
 * other lookup here answers a missing tile: the fact is out of date, and a fight
 * is not worth refusing over it.
 */
export function armorDefence(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): number {
  let total = 0;
  for (const armor of wornArmor(equipment, tilesById)) total += armor.def;
  return total;
}

/**
 * The armour blocks this body is actually wearing, square by square.
 *
 * One walk of {@link ARMOR_SLOTS} shared by the two things that read them, so
 * "which squares are armour, and what counts as armour in one" has a single
 * answer rather than one per arithmetic. Silent about anything the catalogue has
 * lost or no longer agrees belongs in the square it is sitting in.
 */
function wornArmor(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): ArmorItem[] {
  if (!equipment) return [];
  const out: ArmorItem[] = [];
  for (const slot of ARMOR_SLOTS) {
    const instance = equipment[slot];
    if (!instance) continue;
    const def = tilesById[instance.tileId];
    const armor = def ? armorForSlot(slot, def) : null;
    if (armor) out.push(armor);
  }
  return out;
}

/**
 * This tile's armour block, if it is armour *and* it belongs in this square.
 *
 * **The one place "which square does this go in" is asked of a tile**, which is
 * what stops a helmet being wearable as boots: `./itemMoves`' `slotTakes` asks
 * it of a drag, `restoredEquipment` asks it of a kit coming back from storage,
 * and the two would otherwise be two readings of `ArmorItem.slot` to keep in
 * step.
 *
 * Here rather than beside `slotTakes` because it is a fact about the slot, and
 * the slots are defined by this module — the same reason {@link handAccepts}
 * lives here.
 */
export function armorForSlot(slot: ArmorSlot, def: TileDef): ArmorItem | null {
  const armor = resolveArmor(def);
  return armor && armorSlotOf(armor) === slot ? armor : null;
}

/**
 * What the off hand turns aside, if it is holding something that turns anything
 * aside.
 *
 * **The one thing the off hand adds to a fight, and it is deliberately not
 * damage.** Two hands swinging is a whole design — timing, which one lands,
 * what a mastery means when you hold two things — and none of it is needed to
 * answer the question this slot exists for: a torch or a shield. Light comes out
 * of {@link carriedLightTileIds} and defence comes out of here, so both halves
 * of that choice work and neither invents a second attack.
 *
 * Read off a weapon's `def` rather than off {@link ArmorItem}, and it stays that
 * way now that armour has a slot of its own: a shield is a thing you *hold*, and
 * making it armour would put it in the square a breastplate belongs in and let a
 * body wear one instead of the other. Two kinds, two squares, and
 * {@link wornDefence} adds them.
 *
 * **This is the off hand's contribution alone.** The main hand's rides on
 * {@link weaponInHand}, because a held weapon replaces the natural one and its
 * `def` goes along with the rest of it. {@link wornDefence} is where the two
 * meet, and is what any caller asking "how protected is this body" should ask.
 *
 * Zero for an empty hand, a tile the catalogue has lost, and anything with no
 * opinion about defence.
 */
export function offhandDefence(
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): number {
  const held = equipment?.offhand;
  if (!held) return 0;
  const def = tilesById[held.tileId];
  return def ? (resolveWeapon(def)?.def ?? 0) : 0;
}

/**
 * Whether either hand could hold this.
 *
 * **A hand takes anything you can carry**, which is the honest reading of what a
 * hand is: if you would rather hold a second pack than a shield, that is a
 * choice the game has no business refusing. What a thing is *for* is a separate
 * question, answered by `equipSlotOf` — which is what decides where a thing goes
 * when you have not said, and what `WeaponItem.offhand` exists to inform.
 *
 * The one refusal is a container nobody may carry: `equippable: false` is an
 * author saying "this is a chest, it is opened where it lies", and a chest in a
 * fist would be that flag meaning nothing. Armour is *not* a refusal — you can
 * carry a breastplate in your hands, you simply are not wearing it while you do.
 *
 * Here rather than in `./itemMoves` because it is a fact about the slot, and the
 * slot is defined by this module. `restoredEquipment` and the move rules both
 * ask it, and two answers would be a kit that could be saved and not re-equipped.
 */
export function handAccepts(def: TileDef): boolean {
  const item = resolveItem(def);
  if (!item) return false;
  return item.type !== "container" || item.equippable;
}
