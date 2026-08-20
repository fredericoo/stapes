import type { BattlerDef, FightingStats } from "../lib/battler";
import { fightingStats } from "../lib/battler";
import type { WeaponItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { resolveContainer, resolveItem, resolveWeapon } from "../lib/item";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
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

/** Carrying nothing at all — a body that was never given a kit. */
export function emptyEquipment(): Equipment {
  return { weapon: null, offhand: null, bag: null };
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

  const bagDef = saved.bag ? tilesById[saved.bag.tileId] : undefined;
  const container = bagDef ? resolveContainer(bagDef) : null;
  if (!saved.bag || !container?.equippable) {
    return { weapon, offhand, bag: null };
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

  return { weapon, offhand, bag: { ...identified(saved.bag), contents } };
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
const EQUIPMENT_SLOTS: readonly (keyof Equipment)[] = EQUIP_SLOTS;

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
  const guard = offhandDefence(equipment, tilesById);
  return guard === 0 ? stats : { ...stats, def: stats.def + guard };
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
 * Read off a weapon's `def`, which is where defence already lives as a stopgap
 * until armour exists — so a shield is authorable today as an item with a `def`
 * and nothing to speak of anywhere else, and needs no new item type to be
 * invented for it.
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
 * fist would be that flag meaning nothing.
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
