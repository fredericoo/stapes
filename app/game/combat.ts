import { clampChance, type FightingStats } from "../lib/battler";
import {
  MAX_PERCENT_STAT,
  type Reach,
  type WeaponResistances,
  type StatusGrant,
  type WeaponStatus,
} from "../lib/item";
import { absoluteStandingElevation, getStack } from "../lib/mapData";
import type { WeaponMastery } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { type ReachPoint, withinReach } from "./distance";
import { resolveWalkDurationMs } from "./movement";
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

/** Ticks between blows at {@link FightingStats.spd} 0, before haste either way. */
export const MAX_ATTACK_TICKS = 600;

/**
 * The slowest anything ever swings, however short of its weapon it is.
 *
 * Twice the slow end of the curve, so a body that brings nothing at all to a
 * weapon authored at `spd` 0 still swings — see `../lib/battler`'s
 * {@link weaponHandling}, whose floor is a half. A cap rather than an accident
 * of the arithmetic: the shortfall is a handicap, and a handicap that could
 * stop a weapon working outright would be the wall this design replaced.
 */
export const SLOWEST_ATTACK_TICKS = MAX_ATTACK_TICKS * 2;

/**
 * How many of its own steps a blow costs the body that threw it.
 *
 * Two, and the second one is the price of swinging while you run. One step was
 * enough to stop a fight being won by holding a movement key down, and no more
 * than that: a blow came round, the body stood still for exactly as long as a
 * step would have taken, and a retreat that swung on the way out gave up a
 * fraction of its distance. Attacking while withdrawing was very nearly free,
 * which made it the obvious thing to do in every fight — there was no decision
 * in it.
 *
 * At two the decision is real. A player at the 150ms default gives up 300ms of
 * ground per blow, so a running fight is now a choice between the distance and
 * the damage rather than both at once. It is still counted in that body's own
 * steps rather than in milliseconds, for the reason it always was: a creature
 * authored to walk slowly is not punished twice for it.
 *
 * @see {@link strikeRecoveryMs}
 */
export const STRIKE_RECOVERY_STEPS = 2;

/**
 * How long a blow plants the body that threw it, in milliseconds.
 *
 * **Both ends of the wire read this, which is why it is a function and not a
 * number written down twice.** How long a body is planted never travels — the
 * `swung` event carries an id and nothing else — so the simulation and the
 * browser predicting its own footwork each derive it from the tile the body is,
 * exactly as neither end is ever sent a walk's duration. Two readings of the
 * rule is one of them being changed alone, and the symptom would be a player
 * walking a cell the server holds back.
 */
export function strikeRecoveryMs(def: TileDef): number {
  return resolveWalkDurationMs(def) * STRIKE_RECOVERY_STEPS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The lowest haste the interval will divide by.
 *
 * A guard on the arithmetic rather than a rule anybody plays against: nothing
 * produces a haste this low — `weaponHandling` floors at a half and Agility only
 * adds — and a zero here would be a body that never swings again.
 */
const MIN_HASTE = 0.1;

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
  // **Haste runs both ways now**, which is what lets a weapon you are short of
  // be slow without `spd` having to carry it: `spd` is a position on a curve
  // running 100:1 end to end, so docking it by a quarter takes closer to three
  // quarters off the rate. See `../lib/battler`'s {@link FightingStats.haste}.
  //
  // **Floored at the same whole-tick minimum an unhastened body has**, which is
  // not a grudging clamp but the thing the rest of the loop is built on:
  // `STRIKE_DURATION_MS` is chosen to fit inside this gap, so a body that swung
  // faster than it would start its next lean before the last one came home and
  // simply live half a tile from where it stands. A speed limit is a speed
  // limit however you arrive at it.
  const hastened = clamp(
    ticks / Math.max(MIN_HASTE, haste),
    MIN_ATTACK_TICKS,
    SLOWEST_ATTACK_TICKS,
  );
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
 * The share of a swing interval a body spends getting into the blow.
 *
 * A half. Before it, reach alone decided the opening blow: a body that touched
 * something swung on the tick it arrived, which made the whole of an approach
 * free and made it *equally* free for every weapon — a greatsword and a dagger
 * both landed instantly, so the slow weapon got its damage without ever paying
 * its speed. Worse, the cooldown it then owed ran wherever the body went, so the
 * strictly better way to fight was to touch, swing, withdraw for exactly one
 * interval, and come back for the next one with nothing at risk in between.
 *
 * A share rather than a constant, because what it is buying is that the cost of
 * starting a fight scales with the thing you are starting it with. Half of a
 * rat's 867ms is a moment; half of a greatsword's is a second somebody can walk
 * away from.
 *
 * Half rather than a whole, because the windup runs *alongside* the cooldown
 * rather than after it — see {@link swingWindupMs}. At a whole interval a body
 * that never left reach would still be waiting on it when the cooldown cleared,
 * which would halve every rate in the game; at a half, a stand-up fight is
 * exactly the fight it was and only the approach changed.
 */
export const SWING_WINDUP_SHARE = 0.5;

/**
 * How long a body has to have been in reach of its target before it may swing.
 *
 * **Spent alongside the cooldown, not after it.** A body that stays where it is
 * finishes winding up long before its next blow comes round, so a fight between
 * two bodies standing their ground is unchanged. What the windup costs is
 * *arriving*: the first blow of a fight comes half an interval after you get
 * there, and a body that leaves reach starts the wait again when it returns.
 *
 * That is the whole of the rule, and it is deliberately not a fourth thing to
 * dodge: you may still step in and out, and a body that returns within half an
 * interval loses nothing at all. What it can no longer do is be absent.
 *
 * The hand's own interval, exactly as the cooldown is — a body alternating a
 * dagger and an axe winds up for as long as whatever it is about to swing.
 *
 * Rounded to a whole tick, which is what the clock counts in.
 */
export function swingWindupMs(attacker: FightingStats): number {
  const ticks = (swingIntervalMs(attacker) * SWING_WINDUP_SHARE) / TICK_MS;
  return Math.round(ticks) * TICK_MS;
}

/**
 * How long a windup outlives the last reach that held it up.
 *
 * Reach is only asked about where somebody is trying to swing, so a windup has
 * no way of knowing it has been abandoned — and abandoning one has to cost
 * something, or dropping your target, walking away and picking it up again
 * would be the cheap version of the approach this whole rule is about. A windup
 * nobody has confirmed for this long is forgotten, and the next reach that
 * holds starts a fresh one.
 *
 * Two brain rounds, sized by the *slowest* of the two askers rather than by any
 * balance figure: a player's standing target is tried every tick and a
 * creature's brain reaches its `attack` action once a round, so anything under a
 * round would forget every creature's windup between its own turns. The second
 * round is slack for a turn that arrives late — see `GameSession`'s
 * `brainDeferredMs`.
 *
 * It is not a window anybody can play in. Leaving reach *while still asking*
 * drops the windup outright on the tick it happens, which is every tick a player
 * is attacking and every round a creature is; this covers only the case where
 * nobody is asking at all, and two rounds is not enough time to walk out of
 * melee reach and back.
 */
export const WINDUP_LAPSE_MS = BRAIN_TICK_MS * 2;

/**
 * How far apart two contested numbers have to be before the outcome stops being
 * in doubt.
 *
 * Sets the steepness of {@link dodgeChance}'s curve. At twenty, a defender forty
 * behind still gets out of the way about one time in seven, and one twenty ahead
 * is favoured without being untouchable — which is the width the authored
 * Agilities actually span.
 */
export const CONTEST_SCALE = 20;

/**
 * How far ahead of the swinger a defender has to be before a dodge is even
 * money.
 *
 * **A dodge is the exception, and this is the number that says so.** Both sides
 * of the contest now come off the same faculty — see {@link reflex} — so without
 * it, two bodies of equal Agility would dodge half of each other's blows, and
 * two bodies of equal anything is the overwhelmingly common case. The swinger
 * has the initiative: they choose the moment, and the defender is reacting to
 * it.
 *
 * Fifty-five, which is roughly the gap the old rule had by accident. It
 * contested `flee` against an *accuracy* — a number sitting near 85 on anything
 * worth swinging, against evasions running 26 to 65 — and the distance between
 * those two scales was doing this job silently. Naming it is most of the point:
 * how often anybody dodges is now one constant somebody can move, rather than a
 * side effect of how weapon accuracies happen to be authored.
 */
export const REFLEX_EDGE = 55;

/**
 * The chance a blow is avoided entirely, as a fraction of 1.
 *
 * A contest between the defender's evasion and the swinger's reflexes, resolved
 * on a logistic curve: every point either way bends it smoothly rather than in a
 * straight line. Clamped to the band above, so no amount of Agility erases a
 * nimble defender and no amount of evasion makes anybody untouchable.
 *
 * **Both sides are Agility, and the attacker's weapon has no say.** It used to
 * be contested against the attacker's accuracy, which made accuracy answer two
 * questions at once: whether the swing went where it was aimed, *and* whether
 * its target could get out of the way. Those are different questions about
 * different bodies. Whether you execute the attack is a fact about you and the
 * thing in your hand; whether somebody twists away from it is a race between
 * their reflexes and yours. A sharper sword does not make you quicker.
 *
 * What that cost while the two were fused: a weapon authored inaccurate was
 * charged for it twice — once in the swings that went nowhere, and again in
 * losing the contest against everything nimble. The bows were the case that made
 * it visible. An archer with 50 accuracy missed half their shots and had two
 * thirds of the rest dodged by a bat, which is a fifth of what the authored
 * number said.
 *
 * **This used to be `flee - accuracy / 2` before that**, and the halving was a
 * bodge with the same root: accuracy was load-bearing in two places, and the
 * halving was there to stop it being the only stat worth having. A logistic with
 * floors at both ends has no such cliff.
 */
export function dodgeChance(flee: number, attackerReflex: number): number {
  const contest = (flee - attackerReflex - REFLEX_EDGE) / CONTEST_SCALE;
  return clampChance(1 / (1 + Math.exp(-contest)));
}

/**
 * How well this body follows somebody trying not to be hit.
 *
 * **The same number as its own evasion, read the other way round.** Getting out
 * of the way and staying with something that does are one faculty, and a body
 * that has trained Agility has trained both — so this is a field read rather
 * than a second stat, for the reason {@link landChance} is: what it names is the
 * rule. "Whether a blow is dodged is Agility against Agility, and the weapon has
 * no say in it." Two things read that rule — {@link rollAttack} and
 * `./combatMetrics` — and a rule with two expressions is a rule that will be
 * changed in one of them.
 *
 * A separate `reflex` on {@link FightingStats} would be the same number stored
 * twice, and the day somebody put a status on one of them they would have two
 * answers to one question.
 *
 * Not scaled by {@link underPressure}, and that asymmetry is deliberate: being
 * surrounded is what makes *you* easier to hit, not what makes you worse at
 * catching the one body you are swinging at.
 */
export function reflex(attacker: FightingStats): number {
  return attacker.flee;
}

/**
 * How much of its guard a body loses to each attacker past the first.
 *
 * **Eight rats used to be exactly as dangerous as one**, which is the thing this
 * exists to close. Defence is a flat subtraction and evasion is a contest fought
 * one attacker at a time, so a body armoured against a rat's bite was armoured
 * against every rat's bite at once — a player could stand in a swarm and watch
 * their Toughness climb for nothing.
 *
 * Hyperbolic rather than a flat share each — `1 / (1 + k·outnumbering)` — so the
 * second body on you costs the most and the eighth barely registers on top of
 * the seventh. That is the shape being outnumbered actually has: your back is
 * already turned, and one more thing behind it is not the same loss again. It
 * also never reaches zero, so no crowd is ever large enough to make armour mean
 * nothing.
 *
 * A third, which reads as: two bodies leave you three quarters of your guard,
 * four leave you half, eight leave you under a third.
 */
export const GUARD_LOST_PER_ASSAILANT = 0.35;

/**
 * How long after its last swing a body still counts as one of the ones on you.
 *
 * Added to that body's *own* swing interval rather than standing alone, because
 * "still attacking me" is a different length of time for a rat and for something
 * that swings once every ten seconds: a flat window would let anything slow drop
 * out of the count between its own blows and hand the defender their whole guard
 * back for free. The rule is that you count until you are overdue.
 *
 * Two seconds of slack on top — the room a body needs to take a step, be walked
 * around, or lose its turn to a recovery without flickering out of a crowd it is
 * plainly still part of.
 */
export const ASSAILANT_GRACE_MS = 2_000;

/**
 * The share of its evasion and its armour a body keeps with this many bodies
 * swinging at it.
 *
 * One for nought or one attacker alike: a fight nobody is ganging up on is the
 * fight every number in the game was authored against, and the day this returned
 * anything but one for a duel, every authored creature would need retuning.
 */
export function guardShare(assailants: number): number {
  const outnumbering = Math.max(0, assailants - 1);
  return 1 / (1 + GUARD_LOST_PER_ASSAILANT * outnumbering);
}

/**
 * The defender as this blow finds them, with the crowd already counted.
 *
 * **Both halves of defence give way together.** What a blow has to get through
 * is {@link defenceAgainst} — the flat `def` plus whatever the defender is
 * wearing that has an opinion about this kind of blow — so scaling only the flat
 * half would leave a mail shirt turning blades aside as well surrounded as
 * alone, and being outnumbered would be survivable by wearing the right coat.
 *
 * `def` is rounded because hit points are whole. {@link damageAfterDefence}
 * subtracts this from a whole number, and a defence of 1.16 would leave bodies
 * standing on fractions of a hit point that no health bar can draw. `flee` is
 * not rounded and must not be: it is one side of a contest resolved on a curve,
 * where a fraction is simply a position on it.
 *
 * Hands the block straight back when nobody is outnumbering anybody, which is
 * the overwhelming majority of blows struck — a copy per swing to multiply by
 * exactly one is an allocation for nothing.
 */
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

/**
 * The same share taken off every resistance this body is wearing.
 *
 * Rounded apiece for the reason `def` is, and empty stays empty — which is most
 * armour and every creature wearing none.
 */
function pressuredResistances(resist: WeaponResistances, kept: number): WeaponResistances {
  const pressured: WeaponResistances = {};
  for (const [mastery, amount] of Object.entries(resist)) {
    pressured[mastery as WeaponMastery] = Math.round(amount * kept);
  }
  return pressured;
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
export function potentialDamageFrom(attacker: FightingStats, roll: [number, number]): number {
  return damageWorth(attacker.damage, attacker.variance, roll);
}

/**
 * The same thing for a pair of loose figures rather than for a body.
 *
 * A stone's bolt and the editor's damage field are a `damage` and a `variance`
 * with no `FightingStats` around them — a conjured bolt has nobody swinging it —
 * and both have to round exactly where a real blow rounds. Fabricating a whole
 * battler to ask would be inventing five fields to read two.
 */
export function damageWorth(damage: number, variance: number, roll: [number, number]): number {
  return Math.round(damage * damageFraction(variance, roll));
}

/** The narrowest and widest a blow can be worth, before the defender's guard. */
export type DamageBand = {
  min: number;
  max: number;
};

/**
 * The ends of that band, found by handing the real function the ends of its
 * own draw.
 *
 * **A band is the reading, and a variance is not.** "12, spread 35" is a sum the
 * reader has to do before it means anything, and the sum they would do is this;
 * what it takes to kill the thing in front of you is worked out from both ends
 * at once. So the surfaces that report damage to a player report this — see
 * `./attributes`'s `minDamage`, `./itemCard`'s damage row — and none of them
 * quotes a variance at all.
 *
 * Both draws at zero is the floor {@link damageFraction} puts at `1 - variance`;
 * both at one is full damage, because variance widens the band downward only.
 * The rounding is `potentialDamageFrom`'s, so the ends on screen are ends that
 * can actually land rather than a continuous band's edges. The same two probes
 * `./combatMetrics`'s `potentialDamages` bisects between.
 */
export function damageBandOf(damage: number, variance: number): DamageBand {
  return {
    min: damageWorth(damage, variance, [0, 0]),
    max: damageWorth(damage, variance, [1, 1]),
  };
}

/** {@link damageBandOf} for a body that is about to swing something. */
export function damageBand(attacker: FightingStats): DamageBand {
  return damageBandOf(attacker.damage, attacker.variance);
}

/**
 * The least of its defence a body can have standing between it and a blow, as a
 * share of {@link defenceAgainst}.
 *
 * **Armour used to be a flat subtraction, and flat is what made it an on-off
 * switch.** A creature's blow lives in a bounded band — a wolf's is authored at
 * damage 12 and variance 35, so it is *always* worth between 8 and 12 — and
 * `MAX_ARMOR_DEF` is deliberately the same scale as `MAX_WEAPON_DAMAGE`. Put
 * those together and defence 12 was not "very good against wolves": it was total
 * immunity, reachable in the starting kit, and every wolf in the world became
 * scenery on the same afternoon. A rat never got through a cloth tunic.
 *
 * So a blow meets a *draw* from its defender's guard rather than the whole of
 * it. A quarter is the low end, and the choice of low end is the whole rule
 * about what can still be shrugged off entirely: **armour stops a blow outright
 * only when a quarter of it is already the whole blow.** Being untouchable by
 * rats is still reachable and now costs four times the armour it used to, which
 * is a rung on the ladder rather than the second-cheapest charm in the game.
 */
export const MIN_GUARD_SHARE = 0.25;

/**
 * Where in that band a guard draw usually lands, as a share of face value.
 *
 * **The hump, and it is the same argument {@link damageFraction} makes one
 * paragraph up.** A flat draw makes a mail shirt that turned nothing aside
 * exactly as common as one that turned aside everything, which reads as noise
 * rather than as armour: the number on your chest stops predicting anything, and
 * a fight becomes a sequence of unrelated surprises. A peak means armour has a
 * *typical* worth you can plan around, and the two ends stay rare enough to be
 * events — a blow that got through almost untouched, or one your mail swallowed
 * whole.
 *
 * Above the middle of the band on purpose. Armour that usually performs a little
 * better than halfway is armour that mostly does what it says, and the interest
 * is in the tail below it rather than in a symmetric wobble around a number
 * nobody chose.
 */
export const GUARD_PEAK = 0.6;

/**
 * Where one draw puts a guard, as a share of {@link defenceAgainst}.
 *
 * Triangular between {@link MIN_GUARD_SHARE} and the whole of it, peaking at
 * {@link GUARD_PEAK} — the textbook inverse of a triangular distribution's own
 * CDF, so a uniform draw comes out humped without anything having to be
 * resampled or rejected. One draw in, one share out, monotonic in between, which
 * is what lets `./combatMetrics` find each rung's odds by bisecting this rather
 * than by knowing what shape it is.
 *
 * @param roll one draw in [0, 1), which the caller owns for the reason
 *   {@link damageFraction}'s two are: this stays a function of its arguments
 *   rather than a thing that touches the world's dice.
 */
export function guardFraction(roll: number): number {
  const span = 1 - MIN_GUARD_SHARE;
  const below = GUARD_PEAK - MIN_GUARD_SHARE;
  const atPeak = below / span;
  if (roll < atPeak) return MIN_GUARD_SHARE + Math.sqrt(roll * span * below);
  return 1 - Math.sqrt((1 - roll) * span * (1 - GUARD_PEAK));
}

/**
 * The whole numbers of defence a blow of this kind might meet, inclusive.
 *
 * The ends of the band rather than a list, because that is all anybody needs:
 * how often each number inside it comes up is {@link guardFraction}'s shape and
 * is asked of it. Exported because `./combatMetrics` reports the band and
 * because a fixture asserting "this blow cannot get through" has to know where
 * the low end is — see {@link MIN_GUARD_SHARE} for why that number is the rule.
 */
export function guardBand(
  defender: Guarded,
  attacker: Striking,
): { lowest: number; highest: number } {
  const guard = defenceAgainst(defender, attacker);
  return { lowest: Math.round(guard * MIN_GUARD_SHARE), highest: guard };
}

/**
 * How much of its guard this particular blow found, given one draw.
 *
 * Rounded, because hit points are whole and this is subtracted from one. That
 * makes the band a small set of whole numbers whose odds can be worked out
 * exactly, which is the difference between the Arena quoting a figure and the
 * Arena sampling one.
 */
export function guardRolled(defender: Guarded, attacker: Striking, roll: number): number {
  return Math.round(guardFraction(roll) * defenceAgainst(defender, attacker));
}

/**
 * The sliver of a body that armour is read off — everything
 * {@link defenceAgainst} looks at, and nothing else.
 *
 * Named and narrowed for the reason the attacking side already was: what stops a
 * blow is two fields, so a caller that has those two fields has enough. It also
 * makes the band assertable from a fixture that is not a whole fighting body.
 */
export type Guarded = Pick<FightingStats, "def" | "resist">;

/** The sliver of a body that says what kind of blow it strikes. */
export type Striking = Pick<FightingStats, "mastery">;

/**
 * What is left of a blow once the defender's armour has had it.
 *
 * Floors at zero rather than going negative: a blow that cannot get through
 * armour is a blow worth nothing, not a heal.
 *
 * **The attacker is a parameter because armour may care what hit it.** What has
 * to be got through is {@link guardRolled} — a draw against the flat defence
 * plus whatever the defender is wearing that has an opinion about this *kind* of
 * blow — so a caller cannot subtract `defender.def` on its own and quietly
 * forget either the resistance or the draw.
 *
 * Named for the same reason {@link landChance} is: `rollAttack` strikes through
 * it and `./combatMetrics` reports through it, so the day mitigation stops being
 * a subtraction, the Arena's table follows without anybody remembering it
 * exists.
 */
export function damageAfterDefence(
  potentialDamage: number,
  defender: Guarded,
  attacker: Striking,
  guardRoll: number,
): number {
  return Math.max(0, potentialDamage - guardRolled(defender, attacker, guardRoll));
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
  /**
   * Hit points actually taken off, after {@link FightingStats.def} and after
   * {@link cappedToHealth} has trimmed whatever the body did not have left.
   *
   * **Never more than the defender was standing up with.** A blow for sixty on
   * something with nine hit points left did nine, because nine is what there was
   * to do — see {@link cappedToHealth} for why that is a rule about the world
   * rather than a rule about bookkeeping.
   */
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

/**
 * The same blow, with whatever the defender did not have left taken off it.
 *
 * **The most damage a body can take is the health it is standing up with**, and
 * this is where that becomes true. A greatsword swung for sixty at a rat with
 * nine hit points did nine: the other fifty-one went into the air, and nothing
 * downstream should be told otherwise.
 *
 * It matters in three places, and only one of them is arithmetic:
 *
 * - **What a blow teaches you is what it did.** Experience is counted in damage
 *   dealt, so an uncapped overkill let one rat pay as much as the weapon was
 *   theoretically worth rather than as much as the rat was — which is precisely
 *   the grind that `experienceMultiplier` exists to close, arriving by a
 *   different door.
 * - **What floats over a body is a receipt.** `GameSession`'s `applyDamage`
 *   shows this figure, and "60" over something that had nine left is a receipt
 *   for an event that did not happen. `applyHealing` has always made the same
 *   argument on the other side: what actually went in, never what was offered.
 * - **`rollAttack` cannot do it itself**, because it is given two
 *   {@link FightingStats} and neither carries a body's current health — `maxHp`
 *   is what a body is when it is whole. So the trim is a separate step, applied
 *   by each of the two callers that own a body's health: the session's
 *   `tryAttack` and `./duel`'s loop. One function rather than two subtractions,
 *   for the reason `strikeRecoveryMs` is one function: two readings of a rule is
 *   one of them being changed alone.
 *
 * {@link AttackOutcome.potentialDamage} is deliberately left whole. It is what
 * the blow *threatened* rather than what it took, which is the question the
 * defensive payout asks — see `./experience`'s `threatRate`, which weighs it
 * against the body's full health and would read a trimmed figure as a blow that
 * got gentler as its target got closer to death.
 */
export function cappedToHealth(outcome: AttackOutcome, healthLeft: number): AttackOutcome {
  const landed = Math.max(0, Math.min(outcome.damage, healthLeft));
  return landed === outcome.damage ? outcome : { ...outcome, damage: landed };
}

/** No status was inflicted, which is the answer for nearly every blow struck. */
const NOTHING_INFLICTED: readonly never[] = [];

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
 * is {@link guardRolled} — a draw against the defender's flat defence plus
 * whatever they are wearing that has an opinion about this kind of blow.
 */
export function rollAttack(
  attacker: FightingStats,
  defender: FightingStats,
  rng: Rng,
): AttackOutcome {
  const missRoll = rng.next();
  const dodgeRoll = rng.next();
  const damageRoll: [number, number] = [rng.next(), rng.next()];
  // How much of its guard the defender has between it and this blow. Drawn with
  // the rest whether or not the blow ever gets far enough to meet armour, for
  // the reason the three above are: the count is what has to be constant, not
  // the reading. Placed with the damage draws because it is the other half of
  // the same question — what this blow came to — and before the statuses so a
  // weapon that inflicts nothing keeps them last.
  const guardRoll = rng.next();
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

/**
 * What this particular blow has to get through.
 *
 * **Two numbers, added, and the split is what makes armour a choice.** The flat
 * `def` is everything the defender is wearing and holding that stops a blow
 * whatever it was; the resistance is what their armour says about *this kind* of
 * blow, keyed by the attacker's weapon mastery. A mail shirt authored with a
 * sharp resistance is why a sword bounces off it and a hammer does not.
 *
 * Read off the attacker's `mastery` rather than off the wielder's best skill: a
 * novice swinging a sword is still striking with a blade. See
 * `../lib/battler`'s {@link FightingStats.mastery}.
 *
 * The one place the two halves of defence are put together, so nothing else has
 * to know there are two — and so a resistance can never be forgotten by a caller
 * that reached for `defender.def` on its own.
 */
export function defenceAgainst(defender: Guarded, attacker: Striking): number {
  return defender.def + (defender.resist[attacker.mastery] ?? 0);
}

/**
 * Which of a list of statuses took, given a draw apiece.
 *
 * A weapon's list, a bolt's and a plate of raw meat's, which is why it is
 * exported and why it is generic: they are the same authored shape asking the
 * same question, and a second copy of this would be the first place a brand, a
 * branding stone and a bad supper could come to disagree about what a hundred
 * means.
 *
 * **An absent chance is certain**, which is what makes a consumable's grant and
 * a weapon's the same list — see `../lib/item`'s {@link StatusGrant}. It is
 * still *drawn* for, on the fixed-draw-count discipline a swing and an extract
 * are under: a draw skipped because a row was certain would make one item's
 * dice change what the next one rolled.
 *
 * **Read against the authored percentage directly, and not through
 * `clampChance`.** That band exists to keep a *contest* in doubt at both ends —
 * nothing in a fight between two bodies is ever certain. This is not a contest:
 * it is the author saying how often a thing happens, and a hundred that landed
 * ninety-five percent of the time would be a number that quietly means something
 * else.
 */
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
export function inAttackRange(from: ReachPoint, to: ReachPoint, reach: Reach): boolean {
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

/**
 * Where a body is, in the terms reach is measured in.
 *
 * The elevation is the surface it is *standing on* — everything under it in
 * its own stack, plus its level — which is the whole reason reach does not
 * simply read `z`. A rat on a crate is half a level nearer your fist than a
 * rat beside it, and on the board those two are the same cell and the same
 * floor. `z` rides along because line of sight still walks in levels.
 */
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
