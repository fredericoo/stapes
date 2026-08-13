import type { BattlerDef } from "../lib/battler";
import { MAX_PERCENT_STAT, MIN_PERCENT_STAT } from "../lib/battler";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { resolveContainer, resolveWeapon } from "../lib/item";
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
 * The tiles of everything this actor is carrying that gives off light.
 *
 * A projection of {@link Equipment} rather than a second thing to keep in step,
 * and tile ids rather than `LightDef`s because every client already holds the
 * tile catalogue — sending the resolved lights would be sending what the
 * receiver can already look up.
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
  for (const instance of carriedInstances(equipment)) {
    const def = tilesById[instance.tileId];
    if (!def) continue;
    if (resolveLight(def, { direction: instance.direction })) {
      out.push(instance.tileId);
    }
  }
  return out;
}

/**
 * How much of a weapon's weight comes off speed, and how much off accuracy.
 *
 * Full rate against speed and half against accuracy, so a heavy weapon slows how
 * often you swing more than it spoils the blow you land — the two are different
 * complaints and a single rate would make them the same one. Named rather than
 * written as a `/ 2` at the call site, because the ratio is a balance decision
 * and the next person to change it should find one number.
 */
const SPEED_COST_PER_WEIGHT = 1;
const ACCURACY_COST_PER_WEIGHT = 0.5;

/** Speed this much weight costs, as a whole number of stat points. */
export function speedCostOf(weight: number): number {
  return Math.round(Math.max(0, weight) * SPEED_COST_PER_WEIGHT);
}

/** Accuracy this much weight costs, as a whole number of stat points. */
export function accuracyCostOf(weight: number): number {
  return Math.round(Math.max(0, weight) * ACCURACY_COST_PER_WEIGHT);
}

/** Hold a 0–100 stat inside its range after equipment has been spent against it. */
function clampPercent(value: number): number {
  return Math.max(MIN_PERCENT_STAT, Math.min(MAX_PERCENT_STAT, value));
}

/**
 * The stats a body actually fights with, once what it is carrying is counted.
 *
 * `atk` and `def` are unbounded above, exactly as the authored stats are — a
 * weapon is meant to make you hit harder than the tile says. The percent stats
 * are clamped, because they are read as probabilities downstream and a negative
 * accuracy is not a worse accuracy, it is a broken one.
 */
export function applyWeaponStats(
  base: BattlerDef,
  weapon: { atk: number; def: number; weight: number } | null,
): BattlerDef {
  if (!weapon) return base;
  return {
    ...base,
    atk: base.atk + weapon.atk,
    def: base.def + weapon.def,
    spd: clampPercent(base.spd - speedCostOf(weapon.weight)),
    acc: clampPercent(base.acc - accuracyCostOf(weapon.weight)),
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
