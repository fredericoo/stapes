import type { Equipment } from "../app/game/equipment";
import type { ActorSnapshot } from "../app/game/GameSession";
import { resolveBattler } from "../app/lib/battler";
import { resolveDialog } from "../app/lib/dialog";
import { resolveConsumable } from "../app/lib/item";
import type { StatusDef } from "../app/lib/status";
import { PLAYER_TILE_ID } from "../app/game/constants";
import type { Coord, TileDef } from "../app/lib/types";

/**
 * Below a third of the bot's rating a kill teaches nothing
 * (`experienceMultiplier`), so prey at or above it is hunted first.
 */
export const PREY_EXPERIENCE_RATIO = 1 / 3;

export type Rated = Pick<ActorSnapshot, "id" | "tileId" | "x" | "y" | "z" | "hp" | "rating">;

/**
 * A creature that cannot hurt anybody is never a threat, whatever its rating:
 * a rabbit's agility rates it above a new player, and it has no bite at all.
 */
export function canHurt(def: TileDef | undefined): boolean {
  const battler = def ? resolveBattler(def) : null;
  if (!battler) return false;
  return battler.naturalWeapon.damage > 0 || (battler.spells?.length ?? 0) > 0;
}

/**
 * Townsfolk are battlers so a player can kill one, but a bot that hunted or
 * feared them would empty the shops it buys from and flee every street. A body
 * with a dialog is somebody to talk to, so it is never a creature here.
 */
export function creaturesAround<T extends Rated>(
  self: Rated,
  actors: readonly T[],
  tilesById: Record<string, TileDef>,
): T[] {
  return actors.filter((a) => {
    if (a.id === self.id || a.tileId === PLAYER_TILE_ID) return false;
    if (a.hp !== null && a.hp <= 0) return false;
    const def = tilesById[a.tileId];
    return def !== undefined && resolveBattler(def) !== null && resolveDialog(def) === null;
  });
}

export type PreyChoice<T> = {
  /** How a fight with this prey would go, as `Odds.margin`; prey below `courage` is left alone. */
  readonly margin: (prey: T) => number;
  readonly courage: number;
  /** Picked at random among this many of the best. */
  readonly choices: number;
  readonly random: () => number;
  readonly skipped: (id: string) => boolean;
  /** Prey another player is already beside, which goes first: the fight is shared. */
  readonly shared: (prey: T) => boolean;
};

/**
 * The creature to hunt: one the bot expects to beat by at least `courage`
 * (`fightOdds`), never one whose rating is unknown. Among those, prey another
 * player is beside comes first, then one that teaches something before one
 * that does not, then the nearest; the pick is random among the first
 * `choices`, so two bots alone in one place do not always set off after the
 * same rabbit.
 */
export function choosePrey<T extends Rated>(
  self: Rated,
  actors: readonly T[],
  tilesById: Record<string, TileDef>,
  how: PreyChoice<T>,
): T | null {
  const floor = (self.rating ?? 1) * PREY_EXPERIENCE_RATIO;
  const candidates = creaturesAround(self, actors, tilesById).filter(
    (a) => a.rating !== null && !how.skipped(a.id) && how.margin(a) >= how.courage,
  );
  const rank = (a: T) => (how.shared(a) ? 0 : 2) + ((a.rating ?? 0) >= floor ? 0 : 1);
  candidates.sort((a, b) => rank(a) - rank(b) || steps(self, a) - steps(self, b));
  const best = candidates.slice(0, Math.max(1, how.choices));
  return best[Math.floor(how.random() * best.length)] ?? null;
}

/**
 * The bag slot of the food that heals most without risking a bad status:
 * raw meat and anything stale can poison, so they are never eaten to heal.
 */
export function healingFood(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): number | null {
  const bag = equipment.bag?.contents ?? [];
  let bestIndex: number | null = null;
  let bestHp = 0;
  for (let index = 0; index < bag.length; index++) {
    const def = tilesById[bag[index]!.tileId];
    const hp = def ? healing(def, statusDefs) : 0;
    if (hp <= bestHp) continue;
    bestIndex = index;
    bestHp = hp;
  }
  return bestIndex;
}

/**
 * Most food heals by a status rather than at once: a berry gives nothing but
 * `fed`, which mends a point every few seconds for as long as it lasts. A
 * good status that mends is counted as this much health.
 */
export const MENDING_STATUS_HP = 2;

/**
 * Health a food is worth, given at once or through a good status that
 * mends, or 0 for food that heals nothing or risks a bad status.
 */
export function healing(def: TileDef, statusDefs: Record<string, StatusDef>): number {
  const food = resolveConsumable(def);
  if (!food) return 0;
  const grants = food.statuses ?? [];
  if (grants.some((grant) => statusDefs[grant.id]?.tone === "bad")) return 0;
  const mending = grants.filter((grant) => mends(statusDefs[grant.id])).length;
  return Math.max(0, food.hp) + mending * MENDING_STATUS_HP;
}

function mends(status: StatusDef | undefined): boolean {
  return status?.tone === "good" && status.effects?.hp !== undefined;
}

export function isMending(
  statuses: readonly { readonly defId: string }[],
  statusDefs: Record<string, StatusDef>,
): boolean {
  return statuses.some((instance) => mends(statusDefs[instance.defId]));
}

export function steps(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}

export function reach(a: Coord, b: Coord): number {
  if (a.z !== b.z) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
