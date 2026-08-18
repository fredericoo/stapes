import {
  clampChance,
  type FightingStats,
} from "../lib/battler";
import type { MapFile, TileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { type ReachPoint, withinReach } from "./distance";
import type { Rng } from "./rng";
import { hasLineOfSight } from "./sight";

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
 * Ticks between blows at {@link FightingStats.spd} 100 — as fast as it gets.
 *
 * Six rather than two, and the slow end is stretched to match. At two ticks a
 * fight was over before a player could read what was happening to them: the
 * numbers came off faster than they could be counted, and a decision — flee,
 * change target — had nowhere to fit. Both ends are scaled by the same factor so
 * the *shape* of the curve is untouched and every authored `spd` keeps its
 * relative standing; only the clock it runs against is slower.
 */
export const MIN_ATTACK_TICKS = 6;

/** Ticks between blows at {@link FightingStats.spd} 0 — as slow as it gets. */
export const MAX_ATTACK_TICKS = 600;

/**
 * How far a blow reaches — now {@link FightingStats.range}, per creature.
 *
 * It was one cell counted as a square, which was the right shape for a swing and
 * had nowhere to go. A bow is the same question with a bigger answer, and a
 * square that had to become a sphere later would have moved every authored
 * creature on the way past. See `./distance` for the metric and for why height
 * costs what it does.
 */

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
 * How long a body has to be left alone before it starts knitting.
 *
 * Long enough that it never fires between two swings of one fight — the slowest
 * thing on the ladder swings every three seconds — so this is a fact about
 * fights being *over* rather than a trickle of healing inside one. Anything
 * shorter would make a defensive stalemate a thing you could win by waiting.
 */
export const REGEN_DELAY_MS = 5_000;

/**
 * How long a body left alone takes to come back from nothing to full.
 *
 * **This is what "regeneration from Toughness" comes to**, without a second dial
 * to author: recovery is a share of the maximum per second, and Toughness is
 * what sets the maximum, so a tough body knits more hit points per second *and*
 * has more of them. One number, two effects, and no way for the two to disagree.
 *
 * Half a minute, which is what makes the early game survivable without touching
 * a single authored stat. A rat costs a fresh player about half their health and
 * there is nothing on the map to drink; before this, the answer to "how many rats
 * can I kill" was one, and the answer to "then what" was nothing.
 */
export const REGEN_FULL_MS = 30_000;

/**
 * How far apart two contested numbers have to be before the outcome stops being
 * in doubt.
 *
 * Sets the steepness of {@link dodgeChance}'s curve. At twenty, a defender forty
 * behind still gets out of the way about one time in seven, and one twenty ahead
 * is favoured without being untouchable — which is the width the authored
 * evasions and accuracies actually span.
 */
export const CONTEST_SCALE = 20;

/**
 * The chance a blow is avoided entirely, as a fraction of 1.
 *
 * A contest between the defender's evasion and the attacker's accuracy, resolved
 * on a logistic curve: level pegging is a coin toss, and every point either way
 * bends it smoothly rather than in a straight line. Clamped to the band above,
 * so no amount of accuracy erases a nimble defender and no amount of evasion
 * makes anybody untouchable.
 *
 * **This used to be `flee - accuracy / 2`, and the halving was a bodge.** It was
 * there to stop accuracy being the only stat worth having, which it had to be
 * because accuracy was also the only thing deciding whether a blow landed. Once
 * landing became its own question, the linear form collapsed: pushing weapon
 * accuracy up far enough to make hit chances sane drove every dodge in the game
 * to about two percent, and Agility stopped being worth training. A curve with
 * floors at both ends has no such cliff — it is asymptotic where the old one hit
 * zero and stayed there.
 */
export function dodgeChance(flee: number, attackerAccuracy: number): number {
  const contest = (flee - attackerAccuracy) / CONTEST_SCALE;
  return clampChance(1 / (1 + Math.exp(-contest)));
}

/**
 * The share of {@link FightingStats.damage} one blow is worth, before defence.
 *
 * Accuracy sets how *wide* the band is, not where the good end of it is: the top
 * of the band is always full damage, and falling accuracy only drags the floor
 * down. So 100 accuracy is exactly `damage` every time, 50 lands somewhere between
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
export function damageFraction(variance: number, roll: [number, number]): number {
  const spread = clamp(variance, 0, 100) / 100;
  const peaked = (roll[0] + roll[1]) / 2;
  return 1 - spread + spread * peaked;
}

/** What one swing came to. */
export type AttackOutcome = {
  /**
   * The blow never went where it was aimed.
   *
   * **The attacker's failure, and deliberately not the same event as a
   * {@link dodged}.** They look identical from outside — nobody took any damage
   * — but they are opposite facts about who did well, and the experience each
   * one is worth goes to a different party. A dodge is the defender's agility
   * paying off; a miss is the swinger being out of their depth with what they
   * are holding, and it earns nobody anything.
   *
   * Collapsing the two into "no damage" would also make the mastery penalty
   * invisible: a player swinging an axe they cannot lift would see the same
   * thing as a player fighting something nimble, and could not tell that the
   * problem was the axe.
   */
  missed: boolean;
  /** The defender got out of the way; nothing else here happened. */
  dodged: boolean;
  /** Hit points actually taken off, after {@link FightingStats.def}. */
  damage: number;
  /**
   * What the blow would have been worth had it landed, before defence.
   *
   * Zero on a miss, because a swing that went nowhere was never worth anything.
   * On a **dodge** it is the whole point: the design pays the defender's Agility
   * in proportion to what they got out of the way of, so escaping something
   * enormous has to be worth more than escaping a scratch, and by then the blow
   * no longer exists to be measured. Rolling the damage before asking about the
   * dodge is what makes that answerable, and it is free — every draw is taken up
   * front regardless.
   */
  potentialDamage: number;
};

/**
 * Swing once.
 *
 * Three rolls in a fixed order — miss, then dodge, then the damage band — and
 * **all four draws are taken before any of them is read**, so the dice stream
 * advances by the same amount whatever the stats are and whatever the outcome
 * is. A world's dice are seeded to be reproducible, and a draw whose *count*
 * depended on the stats would make one creature's numbers change what every
 * creature after it rolls. Returning early after drawing is the point of the
 * arrangement, not a smell: the cost is paid up front precisely so the early
 * return is free of consequence.
 *
 * Damage floors at zero rather than going negative: a blow that cannot get
 * through armour is a blow worth nothing, not a heal.
 */
export function rollAttack(
  attacker: FightingStats,
  defender: FightingStats,
  rng: Rng,
): AttackOutcome {
  const missRoll = rng.next();
  const dodgeRoll = rng.next();
  const damageRoll: [number, number] = [rng.next(), rng.next()];

  // Missing first, because it happens first: a blow that never went where it was
  // aimed gave the defender nothing to get out of the way of, and crediting them
  // with a dodge for it would pay agility for standing still.
  if (missRoll >= attacker.hitChance) {
    return { missed: true, dodged: false, damage: 0, potentialDamage: 0 };
  }

  // Rolled before the dodge is asked about rather than after, so a blow that is
  // avoided still knows what it was worth. See {@link AttackOutcome.potentialDamage}.
  const potentialDamage = Math.round(
    attacker.damage * damageFraction(attacker.variance, damageRoll),
  );

  if (dodgeRoll < dodgeChance(defender.flee, attacker.accuracy)) {
    return { missed: false, dodged: true, damage: 0, potentialDamage };
  }

  return {
    missed: false,
    dodged: false,
    damage: Math.max(0, potentialDamage - defender.def),
    potentialDamage,
  };
}

/**
 * Is the defender close enough to swing at?
 *
 * A sphere in the metric `./distance` defines, so a body standing on a crate is
 * measured by the crate and not by which floor the crate happens to sit on. At
 * the melee default that sphere is the eight cells around you plus half a level
 * either way.
 *
 * **Range is not the only question, and on its own it is wrong.** Once height
 * counts, the nearest thing to you may be directly under your feet through a
 * floor — one cell away by this measure and quite unhittable. So reach is range
 * *and* a clear line, which is the same line a creature's eye has to have; see
 * {@link canReach}. That was not needed while a swing could only travel
 * sideways to a neighbour, and it is the first thing the sphere breaks.
 */
export function inAttackRange(
  from: ReachPoint,
  to: ReachPoint,
  rangeCells: number,
): boolean {
  return withinReach(from, to, rangeCells);
}

/**
 * Everything between wanting to hit somebody and being allowed to: close enough,
 * and with nothing in the way.
 *
 * The two halves are separate functions because they fail for different reasons
 * and one of them needs the board, but they are asked together everywhere and so
 * are worth having together — a caller that checked range and forgot the wall is
 * a caller that lets a fight happen through a floor.
 */
export function canReach(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: ReachPoint & { z: number },
  to: ReachPoint & { z: number },
  rangeCells: number,
): boolean {
  if (!inAttackRange(from, to, rangeCells)) return false;
  return hasLineOfSight(map, tilesById, from, to);
}
