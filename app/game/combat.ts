import type { BattlerDef } from "../lib/battler";
import type { Coord } from "../lib/types";
import { SIGHT_LEVEL_SLACK, TICK_MS } from "./constants";
import type { Rng } from "./rng";

/**
 * The arithmetic of one blow.
 *
 * Pure functions of two stat blocks and the world's dice, kept out of the
 * session for the same reason `./affordances` is: nothing here knows how a body
 * is found, how hit points are stored, or how anything is broadcast. That also
 * makes every rule below testable by reading it, which for a damage formula is
 * most of the point — a curve nobody can assert about is a curve that will be
 * quietly wrong.
 */

/**
 * Ticks between blows at {@link BattlerDef.spd} 100 — as fast as it gets.
 *
 * Six rather than two, and the slow end is stretched to match. At two ticks a
 * fight was over before a player could read what was happening to them: the
 * numbers came off faster than they could be counted, and a decision — flee,
 * change target — had nowhere to fit. Both ends are scaled by the same factor so
 * the *shape* of the curve is untouched and every authored `spd` keeps its
 * relative standing; only the clock it runs against is slower.
 */
export const MIN_ATTACK_TICKS = 6;

/** Ticks between blows at {@link BattlerDef.spd} 0 — as slow as it gets. */
export const MAX_ATTACK_TICKS = 600;

/**
 * How far a blow reaches, in cells, counted as a square rather than a cross.
 *
 * The one distance in the game measured diagonally, and deliberately so: every
 * *movement* rule counts in steps because a creature that thinks in cells it
 * could walk is a creature whose behaviour matches the board, but a swing does
 * not walk anywhere. Excluding the corners would mean a cat standing on your
 * shoulder diagonally cannot be hit, which no player will read as a rule.
 */
export const ATTACK_RANGE_CELLS = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Milliseconds between one entity's blows.
 *
 * Geometric between the two bounds rather than linear, because linear makes the
 * middle of the range useless: 50 speed would be a blow every hundred ticks,
 * which is indistinguishable from 0 to anybody watching. On this curve 50 is
 * twenty ticks — a fifth of a second short of a blow every two thirds of a
 * second — so a merely decent creature feels decent, and the last stretch to
 * 100 is where the real money is.
 *
 * Rounded to a whole tick, which is what the cooldown is counted in.
 */
export function attackIntervalMs(spd: number): number {
  const t = clamp(spd, 0, 100) / 100;
  const ticks = MAX_ATTACK_TICKS * (MIN_ATTACK_TICKS / MAX_ATTACK_TICKS) ** t;
  return Math.round(ticks) * TICK_MS;
}

/**
 * The chance a blow is avoided entirely, as a fraction of 1.
 *
 * Flee is always read against half the attacker's accuracy: 50 against 50 is
 * `50 - 25`, a quarter. Halving is what keeps accuracy from being the only stat
 * worth having — a perfectly accurate attacker still leaves a nimble defender
 * their whole flee minus fifty, rather than erasing it.
 */
export function dodgeChance(flee: number, attackerAcc: number): number {
  return clamp(flee - attackerAcc / 2, 0, 100) / 100;
}

/**
 * The share of {@link BattlerDef.atk} one blow is worth, before defence.
 *
 * Accuracy sets how *wide* the band is, not where the good end of it is: the top
 * of the band is always full damage, and falling accuracy only drags the floor
 * down. So 100 accuracy is exactly `atk` every time, 50 lands somewhere between
 * half and full, and 0 can produce anything at all.
 *
 * Within the band the roll is triangular — two draws averaged — so the middle is
 * common and both ends are rare. A flat roll would make a shattering blow exactly
 * as likely as a glancing one, which reads as noise rather than as a fight; the
 * hump is what makes an unusually good hit feel like one.
 *
 * @param roll two independent draws in [0, 1), which the caller owns so this
 *   stays a function rather than a thing that touches the world's dice.
 */
export function damageFraction(acc: number, roll: [number, number]): number {
  const spread = 1 - clamp(acc, 0, 100) / 100;
  const peaked = (roll[0] + roll[1]) / 2;
  return 1 - spread + spread * peaked;
}

/** What one swing came to. */
export type AttackOutcome = {
  /** The defender got out of the way; nothing else here happened. */
  dodged: boolean;
  /** Hit points actually taken off, after {@link BattlerDef.def}. */
  damage: number;
};

/**
 * Swing once.
 *
 * Two rolls in a fixed order — dodge first, then the damage band — so the dice
 * stream advances by the same amount whatever the stats are. A world's dice are
 * seeded to be reproducible, and a draw whose *count* depended on accuracy would
 * make one creature's stats change what every creature after it rolls.
 *
 * Damage floors at zero rather than going negative: a blow that cannot get
 * through armour is a blow worth nothing, not a heal.
 */
export function rollAttack(
  attacker: BattlerDef,
  defender: BattlerDef,
  rng: Rng,
): AttackOutcome {
  const dodgeRoll = rng.next();
  const damageRoll: [number, number] = [rng.next(), rng.next()];

  if (dodgeRoll < dodgeChance(defender.flee, attacker.acc)) {
    return { dodged: true, damage: 0 };
  }

  const dealt = Math.round(attacker.atk * damageFraction(attacker.acc, damageRoll));
  return { dodged: false, damage: Math.max(0, dealt - defender.def) };
}

/**
 * Is the defender close enough to swing at?
 *
 * The level slack is the same one sight and reach already use, so a creature on
 * the step above you is in the fight rather than mysteriously exempt from it.
 */
export function inAttackRange(from: Coord, to: Coord): boolean {
  if (Math.abs(from.z - to.z) > SIGHT_LEVEL_SLACK) return false;
  const dx = Math.abs(from.x - to.x);
  const dy = Math.abs(from.y - to.y);
  return Math.max(dx, dy) <= ATTACK_RANGE_CELLS;
}
