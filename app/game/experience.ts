import type { WeaponItem } from "../lib/item";
import {
  type Masteries,
  type MasteryXp,
  learningRate,
  masteryLevel,
} from "../lib/mastery";
import type { AttackOutcome } from "./combat";

/**
 * What a swing is worth to the two bodies either side of it.
 *
 * Pure functions of one {@link AttackOutcome}, kept out of the session for the
 * same reason `./combat` is: nothing here knows how a body is found or where its
 * experience is stored. **Everything these need is already on the outcome** —
 * `missed`, `dodged`, `damage` and `potentialDamage` are exactly the four
 * earning events' inputs, which is why the fight needed no changes to pay for
 * itself.
 *
 * ## Experience goes to the masteries that did the work
 *
 * Not to a pool, and not to whatever the player would like it to go to. You
 * swing a sword, your Blade improves; you get hit, your Toughness does. That is
 * also what makes sandbagging pointless — Rating counts your *best* weapon
 * mastery rather than the one you happen to be holding, so there is nothing to
 * be gained by leaving one untrained.
 */

/**
 * Experience one point of damage is worth, before everything that scales it.
 *
 * The unit the whole economy is denominated in, and one rather than a hundred so
 * that the curve in `../lib/mastery` can be read in the same breath: a mastery's
 * first point costs four damage-worth of fighting at parity.
 */
export const XP_PER_DAMAGE = 1;

/**
 * The share of a landed blow that goes to Agility rather than to the weapon.
 *
 * Small, because landing a blow is mostly the weapon's business — but not
 * nothing, because closing on something and staying on it is footwork. Without
 * it, a player who never gets hit and never gets missed would train Agility only
 * by being fought, which makes the defensive mastery of a good player the one
 * they cannot practise.
 *
 * Paid *on top of* the weapon's share rather than out of it. Splitting the same
 * pot would make picking up a weapon quietly cost you Agility.
 */
export const AGILITY_SHARE_OF_OFFENCE = 0.2;

/**
 * How much of the usual defensive payout the *n*th blow from the same body is
 * worth, and the floor it never goes below.
 *
 * **This does not close AFK-tanking and is not claimed to.** Standing in front
 * of something big is still positive Toughness; what the decay does is stop a
 * rat chewing your ankle from paying for ever, which is the version of the
 * exploit that requires no attention at all. The tighter fix — capping defensive
 * experience against damage you dealt in the same fight — needs per-fight
 * bookkeeping the session does not have.
 *
 * A tenth rather than zero, because a fight that has genuinely gone long is
 * still a fight, and a payout that reaches exactly nothing turns a hard, drawn
 * out win into one worth less than a short easy one.
 */
export const DEFENSIVE_DECAY_PER_PAYOUT = 0.9;
export const MIN_DEFENSIVE_DECAY = 0.1;

/**
 * How long a body has to leave you alone before one payout is forgiven.
 *
 * Ten seconds is several swings from anything on the ladder, so it never fires
 * mid-fight; a full recovery from the floor takes a few minutes of not being
 * hit, which is long enough that walking away and coming back is not a way round
 * the decay.
 */
export const DEFENSIVE_RECOVERY_MS = 10_000;

/** What the *n*th payout from one attacker is worth, as a fraction of 1. */
export function defensiveDecay(payouts: number): number {
  return Math.max(
    MIN_DEFENSIVE_DECAY,
    DEFENSIVE_DECAY_PER_PAYOUT ** Math.max(0, payouts),
  );
}

/**
 * What one swing earns the body that made it.
 *
 * Nothing at all unless it landed: a dodge is the defender's skill and pays
 * them, and a miss is the swinger being out of their depth with what they are
 * holding and pays nobody.
 *
 * Scaled by {@link learningRate}, so a weapon you have outgrown keeps teaching
 * you and keeps teaching you less. **The other direction is deliberately not
 * scaled** — a weapon far above you already pays less by landing far fewer
 * blows, and discounting it twice is what deadlocked the old training wall.
 */
export function attackerEarnings(
  outcome: AttackOutcome,
  weapon: WeaponItem,
  masteries: Masteries,
  multiplier: number,
): MasteryXp {
  if (outcome.missed || outcome.dodged || outcome.damage <= 0) return {};

  const earned = XP_PER_DAMAGE * outcome.damage * multiplier;
  if (earned <= 0) return {};

  const requirement = weapon.requirements?.[weapon.mastery] ?? 0;
  const rate = learningRate(masteryLevel(masteries, weapon.mastery), requirement);

  const earnings: MasteryXp = { agility: earned * AGILITY_SHARE_OF_OFFENCE };
  earnings[weapon.mastery] = earned * rate;
  return earnings;
}

/**
 * What one swing earns the body it was aimed at.
 *
 * **Potential damage on both rows, never actual**, so armour can never starve
 * you of Toughness — the day a breastplate halves what reaches you it must not
 * also halve what you learn from wearing it. On a dodge no damage was ever taken
 * at all, and potential is the only measure there is of what was escaped: the
 * design pays Agility in proportion to the blow avoided, so getting out of the
 * way of something enormous is worth more than getting out of the way of a
 * scratch.
 *
 * A miss earns nothing here. The hit chance is the attacker's weapon and the
 * attacker's mastery and nothing else — the defender contributes not one term to
 * it — so paying them for it would be paying Agility for something Agility did
 * not do.
 */
export function defenderEarnings(
  outcome: AttackOutcome,
  multiplier: number,
  decay: number,
): MasteryXp {
  if (outcome.missed || outcome.potentialDamage <= 0) return {};

  const earned = XP_PER_DAMAGE * outcome.potentialDamage * multiplier * decay;
  if (earned <= 0) return {};

  return outcome.dodged ? { agility: earned } : { toughness: earned };
}
