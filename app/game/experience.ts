import type { Element } from "../lib/element";
import type { WeaponItem } from "../lib/item";
import {
  type Masteries,
  type Mastery,
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
 * swing a sword, your Sharp improves; you get hit, your Toughness does. That is
 * also what makes sandbagging pointless — Rating counts your *best* weapon
 * mastery rather than the one you happen to be holding, so there is nothing to
 * be gained by leaving one untrained.
 */

/**
 * Experience one point of damage is worth, before everything that scales it.
 *
 * The unit the whole economy is denominated in. **Two, and it was one** — the
 * early game asked for about a dozen kills per point of a starter mastery, which
 * is a dozen kills too many for the first thing a player ever does. At two it is
 * six, which is near enough to the fight that caused it to read as cause and
 * effect.
 *
 * Doubled here rather than by halving `../lib/mastery`'s `XP_FOR_FIRST_LEVEL`,
 * and the difference is not cosmetic: experience is *stored*, so moving the cost
 * curve would re-read every player's saved total against a new scale and hand
 * them levels they never fought for. Moving the earning rate leaves everyone
 * exactly where they are and changes only what happens next, which is the honest
 * way to retune a live world.
 */
export const XP_PER_DAMAGE = 2;

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
 * **This never closed AFK-tanking on its own and was never claimed to.** What
 * the decay does is stop a rat chewing your ankle from paying for ever, which is
 * the version of the exploit that requires no attention at all. The part it
 * could not reach — standing in front of something whose blows you have grown
 * too big to feel — is now {@link threatRate}'s, and the two compose: the decay
 * is about *this* attacker having had its turn, and the threat rate is about the
 * blow being beneath you at all.
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
 * The share of a body's health one blow has to threaten before it teaches at
 * the full rate.
 *
 * A fifth, which is five blows to kill you: anything that could end this fight
 * that fast is a fight, and anything that could not is practice.
 *
 * **Where it lands, rather than how steeply it falls, is what this decides.** It
 * is the level at which each creature stops being worth standing in front of: a
 * wolf teaches Toughness at the full rate up to 32, a snake to 29, a cave troll
 * to 51, and a rat almost never — which is the ladder the world is already
 * authored on, stated in the one number that produces it.
 *
 * **This is the defensive half of a rule the offensive half already had.** A
 * weapon you have outgrown keeps teaching you and keeps teaching you less — see
 * `../lib/mastery`'s {@link learningRate} — and until now nothing said the same
 * about a foe you had outgrown. Toughness had no requirement to outgrow, so it
 * earned at full rate for ever while the weapon in your hand earned at a
 * sixtieth, and the gap was not small: on a wolf, in the middle of that grind,
 * Toughness took twenty-eight times what Sharp did from the same exchanges.
 */
export const SIGNIFICANT_THREAT_SHARE = 1 / 5;

/**
 * How sharply a blow beneath you stops teaching you to take it.
 *
 * Four, and deliberately a taper rather than a wall: `../lib/mastery`'s
 * {@link OUTGROWN_FALLOFF} can be steep because a player who has outgrown a
 * weapon can put it down and pick up the next one, and there is no equivalent
 * move here — you cannot take off your Toughness. A cliff would read as a
 * creature that abruptly stopped counting; this reads as one you are steadily
 * getting too big for.
 *
 * Measured on the wolves, which is the fight that produced the complaint: at
 * four, Toughness 40 takes 36 of them instead of 26, and a hundred and twenty
 * leave you at 47 rather than 63.
 */
export const THREAT_FALLOFF = 4;

/**
 * How much of the usual defensive experience a blow this size is worth to a body
 * this big, as a fraction of 1.
 *
 * **Measured against `maxHp` and never against health left**, which is the whole
 * of what stops this becoming a technique: current health would pay most to
 * whoever sat at one hit point, and the optimal way to train Toughness would be
 * to stay nearly dead.
 *
 * Armour is deliberately not in it. What a blow could have done is still what it
 * could have done, so a breastplate halving what reaches you does not halve what
 * you learn from wearing it — the rule this closes is the other one, that a body
 * so tough the blow *cannot* land a mark still banked the whole payout. At
 * Toughness 40 in ordinary starting gear a wolf does literally zero damage per
 * blow and, before this, paid as if it had done nine.
 *
 * Hit points are the yardstick because hit points are what Toughness buys, and
 * they accelerate — see `../lib/battler`'s `MASTERY_ACCELERATION` — so the
 * brake tightens faster than the mastery climbs. That is what makes it
 * self-limiting rather than one more constant to retune.
 */
export function threatRate(potentialDamage: number, maxHp: number): number {
  const significant = Math.max(1, maxHp) * SIGNIFICANT_THREAT_SHARE;
  return Math.min(1, potentialDamage / significant) ** THREAT_FALLOFF;
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
 * Scaled by {@link threatRate}, which is the same sentence one level up: a blow
 * that could take a real bite out of you teaches at the full rate, and one that
 * could not teaches less the bigger you get. **Both rows, not just Toughness** —
 * a dodge you never needed to make is worth as little as a blow you cannot feel,
 * and exempting Agility would leave the whole exploit intact one mastery over.
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
  /**
   * The full health of the body being swung at, which is what the blow is
   * measured against.
   *
   * Passed rather than derived, on the same terms the weapon is passed to
   * {@link attackerEarnings}: this module knows arithmetic and not how a body is
   * found or what it is wearing.
   */
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

/**
 * Experience one cast is worth on its own, before anything it actually did.
 *
 * One, which is four casts to the first point of Arcane and sixteen to the
 * second — see `../lib/mastery`'s `xpForLevel`, whose curve is quadratic. On the
 * shipped Stone of Light's thirty-second cooldown that is two minutes to the
 * first level, which is near enough to the casting that caused it to read as
 * cause and effect.
 *
 * **Deliberately small beside {@link XP_PER_DAMAGE}.** A single point of damage
 * is worth twice a whole cast, so this never competes with what a spell does —
 * it is a way *in* to the mastery rather than a way up it, and a caster who
 * wants Arcane 20 gets it by burning things rather than by pressing a light
 * eight hundred times.
 */
export const XP_PER_CAST = 1;

/**
 * What one cast is worth for having happened at all, whatever it was.
 *
 * **A floor under the profession, and flat on purpose.** Everything else in this
 * module pays for an *outcome* — damage dealt, a blow escaped, health restored —
 * which works for a swordsman because every swing is aimed at somebody, and does
 * not work for a caster. A stone of light does nothing measurable to anybody; a
 * stone of flame asks Arcane 10 before it will fire at all. Paid on outcomes
 * alone, the bottom rung of the ladder would be missing, and the only way onto
 * it would be a stone you are not yet allowed to use.
 *
 * So pressing a stone teaches you a little, and **the amount does not depend on
 * the stone**: not on what it asks of you, not on what came of it, and not on
 * who you happened to be pointing at. Every scale that applies elsewhere is a
 * scale that could take this back to zero, which is the one thing a floor must
 * not do.
 *
 * Paid on the same terms the cooldown is spent — for the cast, not for its
 * result — which is what makes a spell that missed still worth having thrown.
 *
 * @see XP_PER_CAST for the size of it, and why that size.
 */
export function practiceEarnings(
  /**
   * What the spell was made of, so pressing it practises that too.
   *
   * **Paid on top of Arcane rather than out of it**, which is the whole of
   * "Arcane is the global magic level and the elements are what you point it
   * at": every cast trains Arcane, and a cast that is made of something trains
   * that as well. Splitting one fee between them would make a fire specialist
   * slower at magic than somebody pressing a light, which is backwards.
   *
   * Flat, and the same figure Arcane gets, on the same grounds every scale is
   * kept off this: a floor that could be scaled to nothing is not a floor. A
   * two-element spell pays both in full — it also cost twice as much to be
   * allowed to hold. @see `../lib/mastery`'s `spellElements`
   */
  elements: readonly Element[] = [],
): MasteryXp {
  const earnings: MasteryXp = { arcane: XP_PER_CAST };
  for (const element of elements) earnings[element] = XP_PER_CAST;
  return earnings;
}


/**
 * What one cast earns the body that made it.
 *
 * **Keyed on what the spell did, rather than on an attack outcome**, which is
 * the whole reason it is a third function beside the two above rather than a
 * branch inside one of them: a swing has a `missed`, a `dodged` and a
 * `potentialDamage` to read, and a spell has none of those. What a spell has is
 * an amount — health it took off somebody, or health it put back — and the two
 * are paid at the same rate a blow is, so an arcanist and a swordsman advance on
 * one scale.
 *
 * The three rules the caller has to honour before it gets here, because none of
 * them are visible in one number:
 *
 * - **Damage to somebody who is not the caster pays.** That includes damage
 *   dealt later by something the caster conjured — a flame that burns whoever
 *   walks into it pays the person who lit it — which is why a status carries the
 *   actor that caused it. @see `./statuses`'s {@link StatusInstance.causedBy}
 * - **Damage to the caster pays nothing**, so nobody trains by setting
 *   themselves on fire. The caller passes zero rather than this checking, on the
 *   same grounds `attackerEarnings` does not look up who it is paying: this
 *   module knows arithmetic and not who anybody is.
 * - **A heal pays for the health actually restored**, never the amount the stone
 *   names. Pressing a heal at full health restored nothing and teaches nothing,
 *   which is measured by the caller as the health the caster was missing.
 *
 * Scaled by {@link learningRate} exactly as a swing is, off the stone's own
 * requirement: a stone you have outgrown keeps teaching you and keeps teaching
 * you less. Nothing goes to Agility, unlike a landed blow — closing on something
 * and staying on it is footwork, and casting is the one thing in this game you
 * do standing still.
 */
export function casterEarnings(
  /**
   * What the spell came to, in hit points — damage dealt to somebody else, or
   * health actually put back into the caster.
   *
   * One figure for both, because they are paid identically and a spell that
   * both harmed and healed is not a thing the effect vocabulary can say. A
   * caller with two of these to pay for calls twice.
   *
   * **Already scaled by the wheel** where the wheel applies, because this is
   * paid on what the spell *did*: a fire spell that landed half again as hard on
   * something made of nature earns half again as much, and it does so without
   * this function knowing the wheel exists.
   */
  amount: number,
  /**
   * What the stone that did it asks, or nothing when there is no stone left to
   * ask.
   *
   * Undefined is the honest answer for damage dealt by something a caster
   * conjured: by the time a flame burns somebody the stone may have been put
   * down, swapped or lost with its owner's corpse, and what is being paid for is
   * the damage rather than the object. It reads as a requirement of zero, which
   * `learningRate` already means by "asks nothing" — so the indirect case pays
   * at the plain rate rather than through a stone somebody had to invent.
   */
  requirements: Masteries | undefined,
  /**
   * What the spell was made of.
   *
   * Passed rather than derived from the requirements, because the indirect case
   * has no requirements to derive it from: by the time a conjured flame burns
   * somebody the stone may be gone, and what is left is the element the
   * placement remembered. @see `./statuses`'s {@link StatusInstance.elements}
   */
  elements: readonly Element[],
  masteries: Masteries,
  multiplier: number,
): MasteryXp {
  if (amount <= 0) return {};

  const earned = XP_PER_DAMAGE * amount * multiplier;
  if (earned <= 0) return {};

  // On exactly the terms a weapon's is read: what a stone asks of the mastery it
  // *trains* is what decides how much it still has to teach. Each element is
  // read against its own requirement rather than against Arcane's, so a caster
  // who has outgrown a stone's Fire keeps learning from its Water.
  const rateFor = (mastery: Mastery) =>
    learningRate(masteryLevel(masteries, mastery), requirements?.[mastery] ?? 0);

  const earnings: MasteryXp = { arcane: earned * rateFor("arcane") };
  for (const element of elements) earnings[element] = earned * rateFor(element);
  return earnings;
}
