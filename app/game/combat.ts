import {
  clampChance,
  type FightingStats,
} from "../lib/battler";
import { MAX_PERCENT_STAT, type Reach, type WeaponStatus } from "../lib/item";
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
export function attackIntervalMs(spd: number, haste = 1): number {
  const t = clamp(spd, 0, 100) / 100;
  const ticks = MAX_ATTACK_TICKS * (MIN_ATTACK_TICKS / MAX_ATTACK_TICKS) ** t;
  // **Floored at the same whole-tick minimum an unhastened body has**, which is
  // not a grudging clamp but the thing the rest of the loop is built on:
  // `STRIKE_DURATION_MS` is chosen to fit inside this gap, so a body that swung
  // faster than it would start its next lean before the last one came home and
  // simply live half a tile from where it stands. A speed limit is a speed
  // limit however you arrive at it.
  const hastened = Math.max(MIN_ATTACK_TICKS, ticks / Math.max(1, haste));
  return Math.round(hastened) * TICK_MS;
}

/**
 * Milliseconds between this body's blows, its Agility included.
 *
 * **The one every caller in a fight should use.** {@link attackIntervalMs} is
 * the weapon's curve on its own, which is what an editor showing a weapon's
 * speed wants and what nothing swinging at anybody wants — a body's haste is not
 * the weapon's business and cannot be folded into `spd`. Named for the same
 * reason {@link landChance} is: two expressions of "how often does this swing"
 * is one of them being forgotten.
 */
export function swingIntervalMs(attacker: FightingStats): number {
  return attackIntervalMs(attacker.spd, attacker.haste);
}

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
 * The chance a swing finds its target at all, as a fraction of 1.
 *
 * A field read, and a function anyway. **What it names is the rule rather than
 * the number**: "a swing lands exactly when the draw comes in under
 * {@link FightingStats.hitChance}, and nothing else bears on it." Two things
 * read that rule — {@link rollAttack}, which rolls against it, and
 * `./combatMetrics`, which reports how often it holds — and a rule with two
 * expressions is a rule that will be changed in one of them. A flat penalty for
 * a heavy weapon, a floor, a term for the defender: whatever arrives, it arrives
 * here and both readers get it.
 *
 * Deliberately unclamped, because {@link hitChanceFrom} has already held it
 * inside the band nothing in a fight escapes. A second clamp here would be a
 * second ceiling, and the lower of the two would win silently.
 */
export function landChance(attacker: FightingStats): number {
  return attacker.hitChance;
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

/**
 * What one blow is worth before defence, given its two draws.
 *
 * The rounding is the whole reason this is a function of its own. A blow is
 * worth a whole number of hit points, so the continuous band above is really a
 * *discrete* distribution over the integers in it — and an average taken before
 * the rounding is an average of a fight nobody has. `./combatMetrics` works that
 * distribution out exactly by asking this where each whole number begins, which
 * it can only do if the rounding lives somewhere it can reach.
 */
export function potentialDamageFrom(
  attacker: FightingStats,
  roll: [number, number],
): number {
  return Math.round(attacker.damage * damageFraction(attacker.variance, roll));
}

/**
 * What is left of a blow once the defender's armour has had it.
 *
 * Floors at zero rather than going negative: a blow that cannot get through
 * armour is a blow worth nothing, not a heal.
 *
 * **The attacker is a parameter because armour may care what hit it.** What has
 * to be got through is {@link defenceAgainst} — flat defence plus whatever the
 * defender is wearing that has an opinion about this *kind* of blow — so a
 * caller cannot subtract `defender.def` on its own and quietly forget the
 * resistance.
 *
 * Named for the same reason {@link landChance} is: `rollAttack` strikes through
 * it and `./combatMetrics` reports through it, so the day mitigation stops being
 * a subtraction, the Arena's table follows without anybody remembering it
 * exists.
 */
export function damageAfterDefence(
  potentialDamage: number,
  defender: FightingStats,
  attacker: Pick<FightingStats, "mastery">,
): number {
  return Math.max(0, potentialDamage - defenceAgainst(defender, attacker));
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
  /**
   * Statuses this blow leaves on the defender, in the order they were authored.
   *
   * Empty on a miss and on a dodge, because both mean nothing touched anybody.
   * **Not empty merely because the damage came to zero**: armour that swallowed
   * a venomous bite still had a venomous bite land on it, and a weapon whose
   * whole point is what it inflicts would otherwise be turned off by the one
   * stat that has nothing to do with it.
   */
  inflicted: readonly WeaponStatus[];
};

/** No status was inflicted, which is the answer for nearly every blow struck. */
const NOTHING_INFLICTED: readonly WeaponStatus[] = [];

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
 * through armour is a blow worth nothing, not a heal. What counts as armour here
 * is {@link defenceAgainst}, which is the defender's flat defence plus whatever
 * they are wearing that has an opinion about this kind of blow.
 */
export function rollAttack(
  attacker: FightingStats,
  defender: FightingStats,
  rng: Rng,
): AttackOutcome {
  const missRoll = rng.next();
  const dodgeRoll = rng.next();
  const damageRoll: [number, number] = [rng.next(), rng.next()];
  // One draw per authored status, taken here with the rest and read only if the
  // blow gets that far — the same arrangement the three above are under, for the
  // same reason. The count varies with the *weapon* and never with what
  // happened, so a snake that misses and a snake that bites advance the world's
  // dice by exactly as much. Last in the order, so a weapon that inflicts
  // nothing rolls precisely what it rolled before this existed.
  const statusRolls = attacker.statuses.map(() => rng.next());

  // Missing first, because it happens first: a blow that never went where it was
  // aimed gave the defender nothing to get out of the way of, and crediting them
  // with a dodge for it would pay agility for standing still.
  if (missRoll >= landChance(attacker)) {
    return {
      missed: true,
      dodged: false,
      damage: 0,
      potentialDamage: 0,
      inflicted: NOTHING_INFLICTED,
    };
  }

  // Rolled before the dodge is asked about rather than after, so a blow that is
  // avoided still knows what it was worth. See {@link AttackOutcome.potentialDamage}.
  const potentialDamage = potentialDamageFrom(attacker, damageRoll);

  if (dodgeRoll < dodgeChance(defender.flee, attacker.accuracy)) {
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
    damage: damageAfterDefence(potentialDamage, defender, attacker),
    potentialDamage,
    inflicted: inflictedBy(attacker.statuses, statusRolls),
  };
}

/**
 * What this particular blow has to get through.
 *
 * **Two numbers, added, and the split is what makes armour a choice.** The flat
 * `def` is everything the defender is wearing and holding that stops a blow
 * whatever it was; the resistance is what their armour says about *this kind* of
 * blow, keyed by the attacker's weapon mastery. A mail shirt authored with a
 * blade resistance is why a sword bounces off it and a hammer does not.
 *
 * Read off the attacker's `mastery` rather than off the wielder's best skill: a
 * novice swinging a sword is still striking with a blade. See
 * `../lib/battler`'s {@link FightingStats.mastery}.
 *
 * The one place the two halves of defence are put together, so nothing else has
 * to know there are two — and so a resistance can never be forgotten by a caller
 * that reached for `defender.def` on its own.
 */
export function defenceAgainst(
  defender: FightingStats,
  attacker: Pick<FightingStats, "mastery">,
): number {
  return defender.def + (defender.resist[attacker.mastery] ?? 0);
}

/**
 * Which of a weapon's statuses took, given a draw apiece.
 *
 * **Read against the authored percentage directly, and not through
 * `clampChance`.** That band exists to keep a *contest* in doubt at both ends —
 * nothing in a fight between two bodies is ever certain. This is not a contest:
 * it is the author saying how often a thing happens, and a hundred that landed
 * ninety-five percent of the time would be a number that quietly means something
 * else.
 */
function inflictedBy(
  statuses: readonly WeaponStatus[],
  rolls: readonly number[],
): readonly WeaponStatus[] {
  if (statuses.length === 0) return NOTHING_INFLICTED;
  const took = statuses.filter(
    (status, index) => rolls[index] * MAX_PERCENT_STAT < status.chance,
  );
  return took.length === 0 ? NOTHING_INFLICTED : took;
}

/**
 * Is the defender close enough to swing at?
 *
 * **How far a blow reaches is {@link FightingStats.reach}, and it belongs to the
 * weapon.** It was one cell counted as a square, then a sphere on the body, and
 * it is now a disc and a height on the thing being swung. Each move was forced
 * by the one after it: a square could not express a bow, a sphere could not
 * express a bow that does not also shoot through three storeys, and a number on
 * the body could not express a rat that picked one up.
 *
 * A disc and a height in the metric `./distance` defines, so a body standing on
 * a crate is measured by the crate and not by which floor the crate happens to
 * sit on. At the melee default that shape is the eight cells around you plus
 * half a level either way; a bow widens the disc without raising the lid.
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
  reach: Reach,
): boolean {
  return withinReach(from, to, reach);
}

/**
 * Everything between wanting to hit somebody and being allowed to: close enough,
 * and with nothing in the way.
 *
 * The two halves are separate functions because they fail for different reasons
 * and one of them needs the board, but they are asked together everywhere and so
 * are worth having together — a caller that checked range and forgot the wall is
 * a caller that lets a fight happen through a floor.
 *
 * **The line is what a wall costs, and it costs it only here.** Picking a target
 * asks neither half, deliberately: you can point at something across a courtyard
 * and read its name and its health through a window you cannot shoot through,
 * and the shot simply does not go. That distinction was free while every blow
 * was struck at arm's length and is the whole texture of a bow — most of what an
 * archer can see is not, at this instant, something they can hit.
 */
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
