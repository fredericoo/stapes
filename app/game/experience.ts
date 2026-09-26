import type { Element } from "../lib/element";
import type { WeaponItem } from "../lib/item";
import type { Mastery, MasteryXp } from "../lib/mastery";
import type { AttackOutcome } from "./combat";

export const XP_PER_DAMAGE = 2;

export const AGILITY_SHARE_OF_OFFENCE = 0.2;

export const DEFENSIVE_DECAY_PER_PAYOUT = 0.9;
export const MIN_DEFENSIVE_DECAY = 0.1;

export const DEFENSIVE_RECOVERY_MS = 10_000;

export function defensiveDecay(payouts: number): number {
  return Math.max(MIN_DEFENSIVE_DECAY, DEFENSIVE_DECAY_PER_PAYOUT ** Math.max(0, payouts));
}

export function attackerEarnings(
  outcome: AttackOutcome,
  weapon: WeaponItem,
  multiplierFor: (mastery: Mastery) => number,
): MasteryXp {
  if (outcome.missed || outcome.dodged || outcome.damage <= 0) return {};

  const earned = XP_PER_DAMAGE * outcome.damage;
  if (earned <= 0) return {};

  return {
    agility: earned * AGILITY_SHARE_OF_OFFENCE * multiplierFor("agility"),
    [weapon.mastery]: earned * multiplierFor(weapon.mastery),
  };
}

export const SIGNIFICANT_THREAT_SHARE = 1 / 5;

export const THREAT_FALLOFF = 4;

export function threatRate(potentialDamage: number, maxHp: number): number {
  const significant = Math.max(1, maxHp) * SIGNIFICANT_THREAT_SHARE;
  return Math.min(1, potentialDamage / significant) ** THREAT_FALLOFF;
}

export function defenderEarnings(
  outcome: AttackOutcome,
  multiplier: number,
  decay: number,
  maxHp: number,
): MasteryXp {
  if (outcome.missed || outcome.potentialDamage <= 0) return {};

  const earned =
    XP_PER_DAMAGE *
    outcome.potentialDamage *
    multiplier *
    decay *
    threatRate(outcome.potentialDamage, maxHp);
  if (earned <= 0) return {};

  return outcome.dodged ? { agility: earned } : { toughness: earned };
}

export const XP_PER_CAST = 1;

export function practiceEarnings(elements: readonly Element[] = []): MasteryXp {
  const earnings: MasteryXp = { arcane: XP_PER_CAST };
  for (const element of elements) earnings[element] = XP_PER_CAST;
  return earnings;
}

export function casterEarnings(
  amount: number,
  elements: readonly Element[],
  multiplierFor: (mastery: Mastery) => number,
): MasteryXp {
  if (amount <= 0) return {};

  const earned = XP_PER_DAMAGE * amount;
  if (earned <= 0) return {};

  const earnings: MasteryXp = { arcane: earned * multiplierFor("arcane") };
  for (const element of elements) earnings[element] = earned * multiplierFor(element);
  return earnings;
}
