import type { BattlerDef } from "../lib/battler";
import { MAX_PERCENT_STAT, MIN_PERCENT_STAT } from "../lib/battler";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { resolveContainer, resolveItem, resolveWeapon } from "../lib/item";
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
  /** An equippable container. Its `contents` is the inventory. */
  bag: ItemInstance | null;
};

/** Which slot a thing is worn in. */
export type EquipSlot = keyof Equipment;

/** Carrying nothing at all — a body that was never given a kit. */
export function emptyEquipment(): Equipment {
  return { weapon: null, bag: null };
}

/**
 * What a player starts with: an empty hand and a bag on their back.
 *
 * The bag is minted here rather than authored into the map, because it is not
 * in the world — nobody dropped it and there is no placement it came from. Its
 * id is as real as any other, so the starting bag can be dropped, left
 * somewhere, and found again as the same bag.
 *
 * Returns an empty kit rather than throwing when the tile is missing or is not
 * an equippable container: a world whose author has renamed the bag tile should
 * seat players with nothing, not refuse to start.
 */
export function startingEquipment(
  tilesById: Record<string, TileDef>,
  bagTileId: string,
): Equipment {
  const def = tilesById[bagTileId];
  const container = def ? resolveContainer(def) : null;
  if (!container?.equippable) return emptyEquipment();
  return {
    weapon: null,
    bag: { id: mintItemId(), tileId: bagTileId, contents: [] },
  };
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
  const weaponDef = saved.weapon ? tilesById[saved.weapon.tileId] : undefined;
  const weapon =
    saved.weapon && weaponDef && resolveWeapon(weaponDef)
      ? identified(saved.weapon)
      : null;

  const bagDef = saved.bag ? tilesById[saved.bag.tileId] : undefined;
  const container = bagDef ? resolveContainer(bagDef) : null;
  if (!saved.bag || !container?.equippable) return { weapon, bag: null };

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

  return { weapon, bag: { ...identified(saved.bag), contents } };
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

/** Everything worn or carried, slots and bag contents alike, in a flat list. */
export function carriedInstances(equipment: Equipment): ItemInstance[] {
  const out: ItemInstance[] = [];
  if (equipment.weapon) out.push(equipment.weapon);
  if (equipment.bag) {
    out.push(equipment.bag);
    // One level, never recursive: a container may not hold a container, so
    // there is nothing below this to walk.
    if (equipment.bag.contents) out.push(...equipment.bag.contents);
  }
  return out;
}

/**
 * Everything worn in a slot, which is what a light is read off.
 *
 * Deliberately *not* {@link carriedInstances}: what is in the bag is in the bag.
 * The list is over the slots rather than over the two fields by name because
 * there will be more of them — a lamp hook, an off hand — and a projection that
 * had to be edited for each would be the wrong shape from the first one added.
 */
function wornInstances(equipment: Equipment): ItemInstance[] {
  return [equipment.weapon, equipment.bag].filter(
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

/** Hold a 0–100 stat inside its range once equipment has been counted into it. */
function clampPercent(value: number): number {
  return Math.max(MIN_PERCENT_STAT, Math.min(MAX_PERCENT_STAT, value));
}

/**
 * The stats a body actually fights with, once what it is carrying is counted.
 *
 * Every field is a sum, and that is the whole rule: a weapon says what it adds,
 * zero adds nothing, and a negative number takes away. Nothing here decides how
 * much a weapon *costs* — it used to spend one `weight` against speed at full
 * rate and accuracy at half, which made the ratio between those a balance
 * decision hidden in this function rather than a number an author could see.
 *
 * `atk` and `def` are unbounded above, exactly as the authored stats are — a
 * weapon is meant to make you hit harder than the tile says. The percent stats
 * are clamped, because they are read as probabilities downstream and a negative
 * accuracy is not a worse accuracy, it is a broken one.
 */
export function applyWeaponStats(
  base: BattlerDef,
  weapon: { atk: number; def: number; acc: number; spd: number } | null,
): BattlerDef {
  if (!weapon) return base;
  return {
    ...base,
    atk: base.atk + weapon.atk,
    def: base.def + weapon.def,
    spd: clampPercent(base.spd + weapon.spd),
    acc: clampPercent(base.acc + weapon.acc),
  };
}

/**
 * The stats a body fights with, given what it is wearing.
 *
 * The one entry point the simulation uses, so there is a single place where
 * "these are the numbers" is answered — see `GameSession.battlerOf`, which
 * funnels both the swing and the health bar through it. Returns the base object
 * unchanged when there is no weapon, which keeps the overwhelmingly common case
 * free of an allocation per lookup per tick.
 */
export function effectiveBattler(
  base: BattlerDef,
  equipment: Equipment | null,
  tilesById: Record<string, TileDef>,
): BattlerDef {
  const held = equipment?.weapon;
  if (!held) return base;
  const def = tilesById[held.tileId];
  return applyWeaponStats(base, def ? resolveWeapon(def) : null);
}
