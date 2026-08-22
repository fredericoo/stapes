import {
  type BattlerDef,
  type FightingStats,
  resolveBattler,
} from "../lib/battler";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import { type Masteries, MASTERIES } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { effectiveBattler, type Equipment } from "./equipment";
import { slotTakes } from "./itemMoves";

/**
 * A body assembled by hand, for a fight nobody is having.
 *
 * The Arena's half of `./duel`: that runs a fight between two stat blocks, and
 * this is how somebody tuning the game gets a stat block to hand it. Pure, and
 * in `game/` rather than beside the route, because everything it does is a rule
 * of the simulation — which body, wearing what, with which masteries — and a
 * copy of any of those rules living in a component is a copy that will disagree
 * with the world.
 *
 * ## What may be overridden, and what may not
 *
 * **Masteries yes, the natural weapon no.** A mastery is a number a body
 * *earns*, so asking "what does this fight look like at Blade 40" is asking
 * about a body the world can actually produce. A natural weapon is what the
 * creature *is* — a rat's bite is authored fast and light and a snake's slow and
 * heavy, and that axis is the whole reason natural weapons exist at all (see
 * `../lib/battler`). Editing one here would be authoring a new creature through
 * a tuning tool, with nowhere for the edit to go and nothing on disk to show for
 * it. The tile editor is where a bite is changed.
 *
 * Equipment is overridable for the same reason masteries are: picking a weapon
 * up is something anybody can do mid-fight, and "what is this axe worth to a
 * wolf" is exactly the question the kit system made askable.
 */

/** One side of a match-up, as the tuner has set it up. */
export type ArenaFighter = {
  /** Which battler this is. Its natural weapon and sight come from here. */
  tileId: string;
  /**
   * What this body is good at, standing in for whatever the tile says.
   *
   * Always complete rather than sparse — see {@link fighterForTile}. A sparse
   * set reads identically to the simulation, and to a *form* it reads as fields
   * that appear and disappear as somebody types.
   */
  masteries: Masteries;
  /** What is in each square, by tile id, or null for an empty one. */
  equipment: Record<EquipSlot, string | null>;
};

/** Nothing in any square, which is what a body starts the page with. */
function emptySlots(): Record<EquipSlot, string | null> {
  return { weapon: null, offhand: null, bag: null };
}

/**
 * A fighter set up as the tile is authored, ready to be edited.
 *
 * **The kit is deliberately not rolled.** `equipmentForBody` would give what
 * this creature is *likely* to be carrying, and a tuning tool that opened on a
 * dice roll would be a tool whose numbers changed when you reloaded it. A tuner
 * says what the fight is; the world says what a wolf usually has.
 *
 * The masteries are filled out to the whole set, zeroes included, because this
 * is the shape a form edits. Absent and zero mean the same thing to the
 * simulation — see `../lib/mastery` — so nothing downstream can tell.
 */
export function fighterForTile(
  tileId: string,
  tilesById: Record<string, TileDef>,
): ArenaFighter {
  const def = tilesById[tileId];
  const battler = def ? resolveBattler(def) : null;
  const masteries: Masteries = {};
  for (const mastery of MASTERIES) {
    masteries[mastery] = battler?.masteries[mastery] ?? 0;
  }
  return { tileId, masteries, equipment: emptySlots() };
}

/**
 * The body this fighter is, or null when the tile is not one.
 *
 * The authored battler with the tuner's masteries swapped in, and nothing else
 * touched: the natural weapon, the sight and the kit are the tile's own.
 */
export function bodyOf(
  fighter: ArenaFighter,
  tilesById: Record<string, TileDef>,
): BattlerDef | null {
  const def = tilesById[fighter.tileId];
  const battler = def ? resolveBattler(def) : null;
  if (!battler) return null;
  return { ...battler, masteries: fighter.masteries };
}

/**
 * What this fighter is carrying, as the simulation reads equipment.
 *
 * The ids are the slot's own name rather than a minted one, and that is a real
 * difference from a body in the world: an item here is never dropped, traded or
 * put on a wire, so an identity that changed on every keystroke would be churn
 * with nothing reading it. Nothing in `./equipment` reads the id.
 *
 * A slot that names a tile the catalogue has lost, or one that will not take
 * what is in it, comes back empty — the same silence `equipmentFromKit` and
 * `restoredEquipment` keep, and for the same reason: the world moved, the setup
 * did not, and neither is corrupt.
 */
export function equipmentOf(
  fighter: ArenaFighter,
  tilesById: Record<string, TileDef>,
): Equipment {
  const equipment: Equipment = { weapon: null, offhand: null, bag: null };
  for (const slot of EQUIP_SLOTS) {
    const tileId = fighter.equipment[slot];
    if (!tileId) continue;
    const def = tilesById[tileId];
    if (!def || !slotTakes(slot, def)) continue;
    equipment[slot] = { id: `arena:${slot}`, tileId };
  }
  return equipment;
}

/**
 * The numbers this fighter fights with, before any status has touched them.
 *
 * Through `effectiveBattler`, which is the one entry point the simulation uses —
 * so what the Arena reports and what a blow is actually struck with cannot come
 * apart. Null when the tile is not a battler, which the page draws as a body it
 * has nothing to say about rather than as an error.
 */
export function statsOf(
  fighter: ArenaFighter,
  tilesById: Record<string, TileDef>,
): FightingStats | null {
  const body = bodyOf(fighter, tilesById);
  if (!body) return null;
  return effectiveBattler(body, equipmentOf(fighter, tilesById), tilesById);
}

/** Every tile that could stand in the ring, in the order the catalogue holds. */
export function battlerTiles(tiles: TileDef[]): TileDef[] {
  return tiles.filter((tile) => resolveBattler(tile) !== null);
}

/**
 * Every tile a given square would accept.
 *
 * `slotTakes` rather than a list of item types, so the Arena offers exactly what
 * a drag would allow — a hand takes anything you can carry, the back takes only
 * a pack you can wear. A second answer here would let somebody tune a fight
 * around a loadout the game cannot produce.
 */
export function tilesForSlot(slot: EquipSlot, tiles: TileDef[]): TileDef[] {
  return tiles.filter((tile) => slotTakes(slot, tile));
}
