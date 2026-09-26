import { clampChance, type FightingStats } from "../lib/battler";
import {
  isRanged,
  MAX_PERCENT_STAT,
  type Reach,
  type WeaponResistances,
  type StatusGrant,
  type WeaponItem,
  type WeaponStatus,
} from "../lib/item";
import { absoluteStandingElevation, getStack } from "../lib/mapData";
import type { WeaponMastery } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { type ReachPoint, withinReach } from "./distance";
import { type Equipment, HANDS, weaponSwungBy } from "./equipment";
import { resolveWalkDurationMs } from "./movement";
import type { Rng } from "./rng";
import { hasLineOfSight } from "./sight";

/** Must stay above `STRIKE_DURATION_MS` in `constants.ts`. */
export const MIN_ATTACK_TICKS = 6;

export const MAX_ATTACK_TICKS = 600;

export const SLOWEST_ATTACK_TICKS = MAX_ATTACK_TICKS * 2;

export const STRIKE_RECOVERY_STEPS = 2;

export function strikeRecoveryMs(def: TileDef): number {
  return resolveWalkDurationMs(def) * STRIKE_RECOVERY_STEPS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const MIN_HASTE = 0.1;

export function attackIntervalMs(spd: number, haste = 1): number {
  const t = clamp(spd, 0, 100) / 100;
  const ticks = MAX_ATTACK_TICKS * (MIN_ATTACK_TICKS / MAX_ATTACK_TICKS) ** t;
  const hastened = clamp(
    ticks / Math.max(MIN_HASTE, haste),
    MIN_ATTACK_TICKS,
    SLOWEST_ATTACK_TICKS,
  );
  return Math.round(hastened) * TICK_MS;
}

export function swingIntervalMs(attacker: FightingStats): number {
  return attackIntervalMs(attacker.spd, attacker.haste);
}

export const SWING_WINDUP_SHARE = 0.5;

export function swingWindupMs(attacker: FightingStats): number {
  const ticks = (swingIntervalMs(attacker) * SWING_WINDUP_SHARE) / TICK_MS;
  return Math.round(ticks) * TICK_MS;
}

export const WINDUP_LAPSE_MS = BRAIN_TICK_MS * 2;

export const CONTEST_SCALE = 20;

export const REFLEX_EDGE = 55;

export function dodgeChance(flee: number, attackerReflex: number): number {
  const contest = (flee - attackerReflex - REFLEX_EDGE) / CONTEST_SCALE;
  return clampChance(1 / (1 + Math.exp(-contest)));
}

export function reflex(attacker: FightingStats): number {
  return attacker.flee;
}

export const GUARD_LOST_PER_ASSAILANT = 0.35;

export const ASSAILANT_GRACE_MS = 2_000;

export function guardShare(assailants: number): number {
  const outnumbering = Math.max(0, assailants - 1);
  return 1 / (1 + GUARD_LOST_PER_ASSAILANT * outnumbering);
}

export function underPressure(defender: FightingStats, assailants: number): FightingStats {
  const kept = guardShare(assailants);
  if (kept >= 1) return defender;
  return {
    ...defender,
    flee: defender.flee * kept,
    def: Math.round(defender.def * kept),
    resist: pressuredResistances(defender.resist, kept),
  };
}

function pressuredResistances(resist: WeaponResistances, kept: number): WeaponResistances {
  const pressured: WeaponResistances = {};
  for (const [mastery, amount] of Object.entries(resist)) {
    pressured[mastery as WeaponMastery] = Math.round(amount * kept);
  }
  return pressured;
}

export function landChance(attacker: FightingStats): number {
  return attacker.hitChance;
}

export function damageFraction(variance: number, roll: [number, number]): number {
  const spread = clamp(variance, 0, 100) / 100;
  const peaked = (roll[0] + roll[1]) / 2;
  return 1 - spread + spread * peaked;
}

export function potentialDamageFrom(attacker: FightingStats, roll: [number, number]): number {
  return damageWorth(attacker.damage, attacker.variance, roll);
}

export function damageWorth(damage: number, variance: number, roll: [number, number]): number {
  return Math.round(damage * damageFraction(variance, roll));
}

export type DamageBand = {
  min: number;
  max: number;
};

export function damageBandOf(damage: number, variance: number): DamageBand {
  return {
    min: damageWorth(damage, variance, [0, 0]),
    max: damageWorth(damage, variance, [1, 1]),
  };
}

export function damageBand(attacker: FightingStats): DamageBand {
  return damageBandOf(attacker.damage, attacker.variance);
}

export const MIN_GUARD_SHARE = 0.25;

export const GUARD_PEAK = 0.6;

export function guardFraction(roll: number): number {
  const span = 1 - MIN_GUARD_SHARE;
  const below = GUARD_PEAK - MIN_GUARD_SHARE;
  const atPeak = below / span;
  if (roll < atPeak) return MIN_GUARD_SHARE + Math.sqrt(roll * span * below);
  return 1 - Math.sqrt((1 - roll) * span * (1 - GUARD_PEAK));
}

export function guardBand(
  defender: Guarded,
  attacker: Striking,
): { lowest: number; highest: number } {
  const guard = defenceAgainst(defender, attacker);
  return { lowest: Math.round(guard * MIN_GUARD_SHARE), highest: guard };
}

export function guardRolled(defender: Guarded, attacker: Striking, roll: number): number {
  return Math.round(guardFraction(roll) * defenceAgainst(defender, attacker));
}

export type Guarded = Pick<FightingStats, "def" | "resist">;

export type Striking = Pick<FightingStats, "mastery">;

export function damageAfterDefence(
  potentialDamage: number,
  defender: Guarded,
  attacker: Striking,
  guardRoll: number,
): number {
  return Math.max(0, potentialDamage - guardRolled(defender, attacker, guardRoll));
}

export type AttackOutcome = {
  missed: boolean;
  dodged: boolean;
  damage: number;
  potentialDamage: number;
  inflicted: readonly WeaponStatus[];
};

export function cappedToHealth(outcome: AttackOutcome, healthLeft: number): AttackOutcome {
  const landed = Math.max(0, Math.min(outcome.damage, healthLeft));
  return landed === outcome.damage ? outcome : { ...outcome, damage: landed };
}

const NOTHING_INFLICTED: readonly never[] = [];

/**
 * Every draw is taken up front, before any of them is read or an outcome
 * returned early. The world's dice must advance by the same amount whatever
 * the stats and the outcome are, so one creature's numbers cannot change what
 * the next creature rolls. `swingOdds` in `combatMetrics.ts` mirrors this order.
 */
export function rollAttack(
  attacker: FightingStats,
  defender: FightingStats,
  rng: Rng,
): AttackOutcome {
  const missRoll = rng.next();
  const dodgeRoll = rng.next();
  const damageRoll: [number, number] = [rng.next(), rng.next()];
  const guardRoll = rng.next();
  const statusRolls = attacker.statuses.map(() => rng.next());

  if (missRoll >= landChance(attacker)) {
    return {
      missed: true,
      dodged: false,
      damage: 0,
      potentialDamage: 0,
      inflicted: NOTHING_INFLICTED,
    };
  }

  const potentialDamage = potentialDamageFrom(attacker, damageRoll);

  if (dodgeRoll < dodgeChance(defender.flee, reflex(attacker))) {
    return {
      missed: false,
      dodged: true,
      damage: 0,
      potentialDamage,
      inflicted: NOTHING_INFLICTED,
    };
  }

  return {
    missed: false,
    dodged: false,
    damage: damageAfterDefence(potentialDamage, defender, attacker, guardRoll),
    potentialDamage,
    inflicted: inflictedBy(attacker.statuses, statusRolls),
  };
}

export function defenceAgainst(defender: Guarded, attacker: Striking): number {
  return defender.def + (defender.resist[attacker.mastery] ?? 0);
}

/** An absent `chance` is certain, not a default to fall back on. */
export function inflictedBy<Grant extends StatusGrant>(
  statuses: readonly Grant[],
  rolls: readonly number[],
): readonly Grant[] {
  if (statuses.length === 0) return NOTHING_INFLICTED;
  const took = statuses.filter(
    (status, index) =>
      status.chance === undefined || rolls[index]! * MAX_PERCENT_STAT < status.chance,
  );
  return took.length === 0 ? NOTHING_INFLICTED : took;
}

export function inAttackRange(from: ReachPoint, to: ReachPoint, reach: Reach): boolean {
  return withinReach(from, to, reach);
}

export function canReach(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: ReachPoint & { z: number },
  to: ReachPoint & { z: number },
  reach: Reach,
): boolean {
  if (!inAttackRange(from, to, reach)) return false;
  return hasLineOfSight(map, tilesById, from, to);
}

export function reachPointAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: { x: number; y: number; z: number; stackIndex: number },
): ReachPoint & { z: number } {
  const stack = getStack(map, at.x, at.y, at.z);
  return {
    x: at.x,
    y: at.y,
    z: at.z,
    elevAbs: absoluteStandingElevation(at.z, stack.slice(0, at.stackIndex), tilesById),
  };
}

export function rangedWeaponReaches(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  equipment: Equipment | null,
  from: { x: number; y: number; z: number; stackIndex: number },
  to: { x: number; y: number; z: number; stackIndex: number },
): boolean {
  const ranged = HANDS.map((hand) => weaponSwungBy(equipment, tilesById, hand)).filter(
    (weapon): weapon is WeaponItem => weapon !== null && isRanged(weapon),
  );
  if (ranged.length === 0) return false;
  const fromPoint = reachPointAt(map, tilesById, from);
  const toPoint = reachPointAt(map, tilesById, to);
  return ranged.some((weapon) => canReach(map, tilesById, fromPoint, toPoint, weapon.reach));
}
