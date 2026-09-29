import type { FightingStats } from "../lib/battler";
import { MAX_PERCENT_STAT, MAX_WEAPON_DAMAGE } from "../lib/item";
import {
  defenceAgainst,
  dodgeChance,
  guardBand,
  guardRolled,
  landChance,
  potentialDamageFrom,
  reflex,
  swingIntervalMs,
} from "./combat";

export type DamageOdds = {
  value: number;
  chance: number;
};

export function potentialDamages(attacker: FightingStats): DamageOdds[] {
  const worthAt = (mean: number) => potentialDamageFrom(attacker, [mean, mean]);
  const lowest = worthAt(0);
  const highest = worthAt(1);
  if (lowest >= highest) return [{ value: lowest, chance: 1 }];

  const odds: DamageOdds[] = [];
  let from = 0;
  let value = lowest;
  for (let step = 0; step <= MAX_WEAPON_DAMAGE && value < highest; step++) {
    const to = firstDrawAbove(worthAt, value, from);
    odds.push({ value, chance: triangularCdf(to) - triangularCdf(from) });
    from = to;
    const next = worthAt(to);
    if (next <= value) break;
    value = next;
  }
  odds.push({ value, chance: 1 - triangularCdf(from) });
  return odds;
}

export type GuardOdds = {
  value: number;
  chance: number;
};

export function guardOdds(defender: FightingStats, attacker: FightingStats): GuardOdds[] {
  const guardAt = (roll: number) => guardRolled(defender, attacker, roll);
  const { lowest, highest } = guardBand(defender, attacker);
  if (lowest >= highest) return [{ value: highest, chance: 1 }];

  const odds: GuardOdds[] = [];
  let from = 0;
  let value = guardAt(0);
  for (let rung = lowest; rung <= highest && value < highest; rung++) {
    const to = firstDrawAbove(guardAt, value, from);
    odds.push({ value, chance: to - from });
    from = to;
    const next = guardAt(to);
    if (next <= value) break;
    value = next;
  }
  odds.push({ value, chance: 1 - from });
  return odds;
}

const BISECTION_STEPS = 60;

function firstDrawAbove(climbing: (draw: number) => number, value: number, from: number): number {
  let below = from;
  let above = 1;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const middle = (below + above) / 2;
    if (climbing(middle) > value) above = middle;
    else below = middle;
  }
  return above;
}

/**
 * The CDF of the sum of two independent uniform draws on [0, 1], averaged: a
 * triangular distribution peaking at 0.5.
 */
function triangularCdf(mean: number): number {
  if (mean <= 0) return 0;
  if (mean >= 1) return 1;
  if (mean <= 0.5) return 2 * mean * mean;
  return 1 - 2 * (1 - mean) * (1 - mean);
}

export type SwingOdds = {
  defence: number;
  intervalMs: number;
  missed: number;
  dodged: number;
  dodgeWhenAimed: number;
  connected: number;
  absorbed: number;
  wounded: number;
  minDamage: number;
  maxDamage: number;
  meanConnectingDamage: number;
  meanSwingDamage: number;
  mitigation: number;
  statuses: { id: string; perSwing: number }[];
};

/** Mirrors the draw order of `rollAttack` in `combat.ts`. */
export function swingOdds(attacker: FightingStats, defender: FightingStats): SwingOdds {
  const lands = landChance(attacker);
  const dodgeGivenAim = dodgeChance(defender.flee, reflex(attacker));

  const missed = 1 - lands;
  const dodged = lands * dodgeGivenAim;
  const connected = lands * (1 - dodgeGivenAim);

  const band = potentialDamages(attacker);
  const guards = guardOdds(defender, attacker);
  let absorbedGivenConnect = 0;
  let meanPotential = 0;
  let meanConnectingDamage = 0;
  for (const { value, chance } of band) {
    meanPotential += value * chance;
    for (const guard of guards) {
      const together = chance * guard.chance;
      const landed = Math.max(0, value - guard.value);
      meanConnectingDamage += landed * together;
      if (landed === 0) absorbedGivenConnect += together;
    }
  }

  return {
    defence: defenceAgainst(defender, attacker),
    intervalMs: swingIntervalMs(attacker),
    missed,
    dodged,
    dodgeWhenAimed: dodgeGivenAim,
    connected,
    absorbed: connected * absorbedGivenConnect,
    wounded: connected * (1 - absorbedGivenConnect),
    minDamage: Math.max(0, (band[0]?.value ?? 0) - (guards[guards.length - 1]?.value ?? 0)),
    maxDamage: Math.max(0, (band[band.length - 1]?.value ?? 0) - (guards[0]?.value ?? 0)),
    meanConnectingDamage,
    meanSwingDamage: connected * meanConnectingDamage,
    mitigation: meanPotential > 0 ? 1 - meanConnectingDamage / meanPotential : 0,
    statuses: attacker.statuses.map((status) => ({
      id: status.id,
      perSwing: connected * (status.chance / MAX_PERCENT_STAT),
    })),
  };
}

export type RotationOdds = {
  swings: SwingOdds[];
  attacksPerSecond: number;
  damagePerSecond: number;
  swingsToKill: number | null;
  secondsToKill: number | null;
};

/**
 * `Duel` swings a body's hands in turn and waits each blow's own interval after
 * it, so one rotation strikes with every hand once. The whole-fight figures are
 * therefore means over the rotation, not the sum of each hand's rate.
 */
export function rotationOdds(
  swings: readonly FightingStats[],
  defender: FightingStats,
): RotationOdds {
  const odds = swings.map((swing) => swingOdds(swing, defender));
  const intervalMs = meanOf(odds, (swing) => swing.intervalMs);
  const meanSwingDamage = meanOf(odds, (swing) => swing.meanSwingDamage);
  const attacksPerSecond = 1000 / intervalMs;
  const damagePerSecond = meanSwingDamage * attacksPerSecond;

  return {
    swings: odds,
    attacksPerSecond,
    damagePerSecond,
    swingsToKill: meanSwingDamage > 0 ? defender.maxHp / meanSwingDamage : null,
    secondsToKill: damagePerSecond > 0 ? defender.maxHp / damagePerSecond : null,
  };
}

function meanOf(odds: readonly SwingOdds[], figure: (swing: SwingOdds) => number): number {
  let total = 0;
  for (const swing of odds) total += figure(swing);
  return total / odds.length;
}
