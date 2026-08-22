import type { FightingStats } from "../lib/battler";
import { MAX_PERCENT_STAT, MAX_WEAPON_DAMAGE } from "../lib/item";
import {
  damageAfterDefence,
  defenceAgainst,
  dodgeChance,
  landChance,
  potentialDamageFrom,
  swingIntervalMs,
} from "./combat";

/**
 * What a match-up comes to in the long run, worked out rather than sampled.
 *
 * **Exact, and that is the whole reason this is not a thousand runs of
 * `./duel`.** A balance figure with sampling noise in it is a figure nobody can
 * tune against: move a weapon's accuracy by a point, watch the number move by
 * three, and you cannot tell which of the two was you. The same inputs give the
 * same answer to the last decimal, so a change of one point shows as a change of
 * one point.
 *
 * ## Nothing here restates a rule of a fight
 *
 * The obvious way to write a closed form is to work the arithmetic out on paper
 * and type the result in. That is how this started, and it is a trap with a long
 * fuse: the day somebody changes how accuracy works, the fight changes and the
 * table quietly does not, and the table is what they are changing it *against*.
 *
 * So every rule is **called**, never copied — {@link landChance},
 * {@link dodgeChance}, {@link potentialDamageFrom}, {@link damageAfterDefence},
 * {@link swingIntervalMs}. Where a closed form needs to know something the
 * functions do not hand over — *where* in the draw does one whole number of
 * damage become the next — it finds out by asking them, which is what
 * {@link potentialDamages} bisects for. Change a curve in `./combat` and the
 * table follows on the next render without anybody remembering this file exists.
 *
 * Two things are still assumed here, and **both are facts about the dice rather
 * than about combat**: the draws are independent and uniform, and the damage
 * band's two draws enter only through their mean (which is what makes
 * {@link triangularCdf} the right measure and `[t, t]` a faithful probe). Both
 * are asserted in `./combatMetrics.test.ts`, against `Rng` and against
 * `damageFraction` itself.
 */

/** One possible worth of a blow before defence, and how often it comes up. */
export type DamageOdds = {
  /** Hit points, before the defender's `def`. */
  value: number;
  /** Fraction of connecting blows worth exactly this. */
  chance: number;
};

/**
 * The exact distribution of what one connecting blow is worth before defence.
 *
 * `potentialDamageFrom` rounds to whole hit points, so the continuous band is
 * really a discrete distribution over the integers in it — and the rounding and
 * the floor at zero are exactly the two things an average taken before them gets
 * wrong. Every figure below is a sum over this.
 *
 * **Found by asking the real function where each whole number begins**, rather
 * than by inverting it on paper. The damage draw is two uniforms that enter
 * through their mean, so a mean of `t` is probed as `[t, t]`; the worth climbs
 * with `t`, so the boundary between one whole number and the next is a single
 * crossing and bisection finds it to the last bit a double can hold. What is
 * left to work out is only *how often a draw-mean falls in that interval*, which
 * is {@link triangularCdf} and is a fact about the dice.
 */
export function potentialDamages(attacker: FightingStats): DamageOdds[] {
  const worthAt = (mean: number) => potentialDamageFrom(attacker, [mean, mean]);
  const lowest = worthAt(0);
  const highest = worthAt(1);
  // No band at all — a zero-variance weapon, or one that does no damage. Every
  // blow is worth the same, and there is nothing to bisect for.
  if (lowest >= highest) return [{ value: lowest, chance: 1 }];

  const odds: DamageOdds[] = [];
  let from = 0;
  let value = lowest;
  // Bounded by the widest band there could be, so a curve that stopped climbing
  // ends the walk rather than hanging the page that drew it. See the guard on
  // the last line of the loop.
  for (let step = 0; step <= MAX_WEAPON_DAMAGE && value < highest; step++) {
    const to = firstMeanWorthMoreThan(worthAt, value, from);
    odds.push({ value, chance: triangularCdf(to) - triangularCdf(from) });
    from = to;
    const next = worthAt(to);
    if (next <= value) break;
    value = next;
  }
  // Everything above the last boundary, which is the top of the band: always
  // full damage, because variance widens the band downward only.
  odds.push({ value, chance: 1 - triangularCdf(from) });
  return odds;
}

/**
 * Enough halvings to pin a boundary to the last bit of a double.
 *
 * The unit interval halved sixty times is far below what any number here can
 * tell apart, which is the point: the figures this feeds are quoted to a tenth
 * of a percent, and a boundary found approximately would show up as a
 * distribution whose terms do not quite sum to one.
 */
const BISECTION_STEPS = 60;

/** The lowest draw-mean at or above `from` worth more than `value`. */
function firstMeanWorthMoreThan(
  worthAt: (mean: number) => number,
  value: number,
  from: number,
): number {
  let below = from;
  let above = 1;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const middle = (below + above) / 2;
    if (worthAt(middle) > value) above = middle;
    else below = middle;
  }
  return above;
}

/**
 * Where the mean of two uniform draws falls, as a probability.
 *
 * Two halves of a parabola meeting at the peak: the sum of two uniforms is the
 * textbook triangular, and averaging it only rescales the axis.
 *
 * **A fact about the dice, not about a fight**, which is why it is the one piece
 * of arithmetic in this file that is written out rather than called. It says how
 * often a draw lands where; what that draw is *worth* is `./combat`'s business
 * and is asked of it.
 */
function triangularCdf(mean: number): number {
  if (mean <= 0) return 0;
  if (mean >= 1) return 1;
  if (mean <= 0.5) return 2 * mean * mean;
  return 1 - 2 * (1 - mean) * (1 - mean);
}

/**
 * Everything one side's swings are worth against the other, per swing and per
 * second.
 *
 * Read one way round: `attacker` swinging at `defender`. A match-up is two of
 * these and they are not symmetric — see the two columns the Arena draws.
 */
export type SwingOdds = {
  /**
   * What this attacker's blows have to get through — the defender's flat
   * defence plus whatever they are wearing that has an opinion about *this kind*
   * of blow.
   *
   * Reported rather than left implicit because armour is keyed by the attacker's
   * weapon mastery: the same defender turns aside a sword and a hammer by
   * different amounts, and a table quoting one number for "defence" would hide
   * the whole reason armour is a choice.
   */
  defence: number;
  /** Milliseconds the attacker waits between blows. */
  intervalMs: number;
  attacksPerSecond: number;
  /**
   * Share of swings that never found the target — the attacker's own failure,
   * and deliberately not the same thing as {@link dodged}. See `./combat`.
   */
  missed: number;
  /** Share of swings the defender got out of the way of. */
  dodged: number;
  /**
   * The same, counted only over blows that were aimed properly.
   *
   * **What Agility is actually worth**, and the figure {@link dodged}
   * understates: a share of *all* swings folds the attacker's own misses into
   * the defender's credit going one way and dilutes it going the other. A
   * defender who dodges six aimed blows in seven reads as dodging half of
   * everything thrown at them, which is the wrong number to tune a stat on.
   *
   * Contested against the attacker's accuracy, so it is a fact about the pair
   * and not about the defender — the same evasion is worth less against a
   * precise weapon.
   */
  dodgeWhenAimed: number;
  /** Share of swings that reached a body. */
  connected: number;
  /**
   * Share of swings that reached a body and came to nothing, because defence
   * was worth at least the whole blow.
   *
   * **The nearest true thing to "blocked", and it is not a separate roll.**
   * There is no block mechanic: defence is taken off a blow that has already
   * landed, so what looks like a block is a blow whose whole worth the armour
   * ate. Worth its own figure precisely because it is invisible in an average —
   * a defence that swallows a third of the blows outright is a very different
   * fight from one that shaves a third off each of them, and the two can produce
   * the same mean.
   */
  absorbed: number;
  /** Share of swings that actually took hit points off. */
  wounded: number;
  /** The least a connecting blow can do, after defence. */
  minDamage: number;
  /** The most a connecting blow can do, after defence. */
  maxDamage: number;
  /** Mean of a connecting blow, after defence. */
  meanConnectingDamage: number;
  /** Mean over every swing, misses and dodges counted as the zeroes they are. */
  meanSwingDamage: number;
  damagePerSecond: number;
  /**
   * Share of a connecting blow's raw worth that defence takes off, on average.
   *
   * Zero against a defenceless target and one against a blow armour swallows
   * entirely. The other half of {@link absorbed} — this is how much, that is how
   * often.
   */
  mitigation: number;
  /** Blows needed to take the defender from full health to nothing, on average. */
  swingsToKill: number | null;
  /** The same in seconds, at this attacker's rate. */
  secondsToKill: number | null;
  /** What a swing leaves behind, per authored status on the weapon. */
  statuses: { id: string; perSwing: number }[];
};

/**
 * The whole match-up, one way round.
 *
 * Conditioned in the same order a swing resolves — miss, then dodge, then the
 * band, then defence — because that order is the arithmetic and not a
 * presentation choice: a dodge is only possible on a blow that was aimed
 * properly, and defence only applies to one that arrived. It is `rollAttack`'s
 * order, and if that changes, `./combat.test.ts`'s draw-count assertions are
 * what fail first and send somebody here.
 */
export function swingOdds(
  attacker: FightingStats,
  defender: FightingStats,
): SwingOdds {
  const intervalMs = swingIntervalMs(attacker);
  const attacksPerSecond = 1000 / intervalMs;

  // A swing lands when its draw comes in under the chance; a uniform draw does
  // that exactly that often. Both halves read off `./combat` rather than off the
  // stat block, so a rule that grows a term grows it in one place.
  const lands = landChance(attacker);
  const dodgeGivenAim = dodgeChance(defender.flee, attacker.accuracy);

  const missed = 1 - lands;
  const dodged = lands * dodgeGivenAim;
  const connected = lands * (1 - dodgeGivenAim);

  const band = potentialDamages(attacker);
  let absorbedGivenConnect = 0;
  let meanPotential = 0;
  let meanConnectingDamage = 0;
  for (const { value, chance } of band) {
    const landed = damageAfterDefence(value, defender, attacker);
    meanPotential += value * chance;
    meanConnectingDamage += landed * chance;
    if (landed === 0) absorbedGivenConnect += chance;
  }

  const meanSwingDamage = connected * meanConnectingDamage;
  const damagePerSecond = meanSwingDamage * attacksPerSecond;

  return {
    defence: defenceAgainst(defender, attacker),
    intervalMs,
    attacksPerSecond,
    missed,
    dodged,
    dodgeWhenAimed: dodgeGivenAim,
    connected,
    absorbed: connected * absorbedGivenConnect,
    wounded: connected * (1 - absorbedGivenConnect),
    minDamage: damageAfterDefence(band[0]?.value ?? 0, defender, attacker),
    maxDamage: damageAfterDefence(
      band[band.length - 1]?.value ?? 0,
      defender,
      attacker,
    ),
    meanConnectingDamage,
    meanSwingDamage,
    damagePerSecond,
    mitigation:
      meanPotential > 0 ? 1 - meanConnectingDamage / meanPotential : 0,
    swingsToKill:
      meanSwingDamage > 0 ? defender.maxHp / meanSwingDamage : null,
    secondsToKill:
      damagePerSecond > 0 ? defender.maxHp / damagePerSecond : null,
    // Per *swing* rather than per connecting blow, because that is the rate an
    // author is choosing when they type a chance: a venom on a weapon that
    // lands one blow in five is a venom that takes one swing in fifty, and the
    // authored 10% says nothing about which of those it meant.
    statuses: attacker.statuses.map((status) => ({
      id: status.id,
      perSwing: connected * (status.chance / MAX_PERCENT_STAT),
    })),
  };
}
