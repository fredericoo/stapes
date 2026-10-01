import type { Equipment } from "../app/game/equipment";
import type { ActorSnapshot } from "../app/game/GameSession";
import { resolveBattler } from "../app/lib/battler";
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

export function creaturesAround<T extends Rated>(
  self: Rated,
  actors: readonly T[],
  tilesById: Record<string, TileDef>,
): T[] {
  return actors.filter((a) => {
    if (a.id === self.id || a.tileId === PLAYER_TILE_ID) return false;
    if (a.hp !== null && a.hp <= 0) return false;
    const def = tilesById[a.tileId];
    return def !== undefined && resolveBattler(def) !== null;
  });
}

export type ThreatRule = { readonly threatRatio: number; readonly threatMargin: number };

export function isThreat(
  self: Rated,
  other: Rated,
  tilesById: Record<string, TileDef>,
  rule: ThreatRule,
): boolean {
  if (other.rating === null) return false;
  const line = (self.rating ?? 1) * rule.threatRatio + rule.threatMargin;
  return other.rating > line && canHurt(tilesById[other.tileId]);
}

export type PreyChoice = {
  readonly threat: ThreatRule;
  /** Picked at random among this many of the best. */
  readonly choices: number;
  readonly random: () => number;
  readonly skipped: (id: string) => boolean;
  /** Prey somebody else is already beside, which goes to the back. */
  readonly taken: (prey: Rated) => boolean;
};

/**
 * The creature to hunt: never a threat, nor one whose rating is unknown.
 * Among the rest, prey nobody else is beside comes before prey that is taken,
 * then one that teaches something before one that does not, then the nearest;
 * the pick is random among the first `choices`, so two bots in one place do
 * not set off after the same rabbit.
 */
export function choosePrey<T extends Rated>(
  self: Rated,
  actors: readonly T[],
  tilesById: Record<string, TileDef>,
  how: PreyChoice,
): T | null {
  const floor = (self.rating ?? 1) * PREY_EXPERIENCE_RATIO;
  const candidates = creaturesAround(self, actors, tilesById).filter(
    (a) => a.rating !== null && !isThreat(self, a, tilesById, how.threat) && !how.skipped(a.id),
  );
  const rank = (a: T) => (how.taken(a) ? 2 : 0) + ((a.rating ?? 0) >= floor ? 0 : 1);
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
    const food = def ? resolveConsumable(def) : null;
    if (!food || food.hp <= bestHp) continue;
    if (food.statuses?.some((grant) => statusDefs[grant.id]?.tone === "bad")) continue;
    bestIndex = index;
    bestHp = food.hp;
  }
  return bestIndex;
}

export function steps(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}

export function reach(a: Coord, b: Coord): number {
  if (a.z !== b.z) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
