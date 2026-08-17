import * as v from "valibot";

/**
 * What a body is good at.
 *
 * There are no levels. A body is a set of masteries, and every number a fight is
 * fought with is derived from them — see `./battler`. Players earn theirs;
 * creatures are authored with theirs and never improve.
 *
 * ## Why this is its own module
 *
 * A weapon answers to a mastery and a body *has* masteries, so both `./item` and
 * `./battler` need this vocabulary. They cannot get it from each other: a body's
 * natural weapon is a `WeaponItem`, so `./battler` already imports `./item`, and
 * an import back the other way would be a cycle. Two modules needing the same
 * words is exactly what a third module is for.
 *
 * Nothing here knows what a tile is, which is what keeps it at the bottom of the
 * graph.
 */

/**
 * The masteries a weapon can answer to.
 *
 * `fist` is not "no weapon" — it is the mastery bare hands answer to, and bare
 * hands are a weapon like any other. See `./battler`'s natural weapons for why
 * that framing is load-bearing rather than cute.
 *
 * `arcane` was `magic`, and the rename collapsed two names for one number: the
 * original design had Arcane as a body mastery governing magic damage and
 * cooldowns, and `magic` as the mastery a staff answered to. Those cannot be
 * separate — swinging a staff is how you get better at magic, and being better
 * at magic is what makes the staff work. Splitting them would describe a wizard
 * who trains one and casts with the other.
 */
export type WeaponMastery = "fist" | "blade" | "blunt" | "ranged" | "arcane";

/**
 * The masteries nothing is held to practise.
 *
 * Earned by being in a fight rather than by swinging in one: toughness from
 * taking blows, agility from avoiding them. They have no gear to train against,
 * which is a known gap rather than a design — see `plans/masteries.md`.
 */
export type BodyMastery = "toughness" | "agility";

export type Mastery = WeaponMastery | BodyMastery;

export const WEAPON_MASTERIES: WeaponMastery[] = [
  "fist",
  "blade",
  "blunt",
  "ranged",
  "arcane",
];

export const BODY_MASTERIES: BodyMastery[] = ["toughness", "agility"];

export const MASTERIES: Mastery[] = [...WEAPON_MASTERIES, ...BODY_MASTERIES];

/** Both ends of a mastery, named so the editor and the schema agree. */
export const MIN_MASTERY = 0;
export const MAX_MASTERY = 100;

/**
 * What a body is good at, as far as it has got.
 *
 * Sparse on purpose, and the sparseness is the documentation: a rat has no
 * opinion about `arcane`, and writing a zero for it would claim the author
 * considered the question. Absent and zero mean the same thing to every reader —
 * see {@link masteryLevel} — so nothing downstream has to care which it got.
 */
export type Masteries = Partial<Record<Mastery, number>>;

/** One mastery's level, with an unwritten one reading as the bottom of the scale. */
export function masteryLevel(masteries: Masteries, mastery: Mastery): number {
  return masteries[mastery] ?? MIN_MASTERY;
}

/**
 * One number, doing two jobs.
 *
 * **Performance.** {@link masteryRatio} caps here, so a Blade-100 hero holding a
 * requirement-1 dagger performs as though they had 1.25 — no twinking, and no
 * veteran clearing a dungeon with a stick.
 *
 * **Learning.** Up to here a weapon teaches its mastery at full rate; past here
 * the rate falls away — see {@link learningRate}. It is the same number so that
 * "a weapon you have outgrown" and "a weapon that has stopped teaching you" are
 * the same sentence.
 *
 * This used to be a wall: experience simply stopped at `requirement × 1.25` and
 * you had to go and find a better axe. That produced a deadlock in the other
 * direction — a weapon asking anything of a mastery you had none of could never
 * teach that mastery, because you could never land a blow with it, so there was
 * no way from Blade 0 to Blade 1 at all. A falloff has the pacing the wall was
 * for without the dead end, and it is the honest model besides: you do keep
 * learning from a weapon you have outgrown, just barely.
 */
export const MAX_MASTERY_RATIO = 1.25;

/** What a weapon asking nothing is worth: neither penalty nor bonus. */
export const UNREQUIRED_RATIO = 1;

/**
 * How well a body meets what a weapon asks of it, as a fraction of 1.
 *
 * **The worst ratio across every requirement decides**, so a Double Axe asking
 * Blunt 35 and Toughness 20 is held back by whichever of yours is further
 * behind. That is worth knowing rather than hiding: a secondary requirement can
 * quietly halve this, and the player will feel it as the weapon simply not
 * working. Whatever shows a weapon's requirements has to show them one by one.
 *
 * A requirement of zero is not a requirement — it reads as absent, on the same
 * terms {@link masteryLevel} reads an unwritten mastery as zero. A weapon that
 * asks nothing at all is {@link UNREQUIRED_RATIO}, which is neither a penalty
 * nor a gift: bare hands should not be better than a sword for being simpler.
 */
export function masteryRatio(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  if (!requirements) return UNREQUIRED_RATIO;

  let worst = Infinity;
  for (const mastery of MASTERIES) {
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    worst = Math.min(worst, masteryLevel(masteries, mastery) / required);
  }

  if (worst === Infinity) return UNREQUIRED_RATIO;
  return Math.max(0, Math.min(MAX_MASTERY_RATIO, worst));
}

/**
 * The highest a weapon asking this much still teaches at full rate.
 *
 * Floored, because a mastery is a whole number and a figure of 43.75 would be
 * 43 wearing a decimal that reads as if it meant something.
 *
 * **No longer a wall** — see {@link MAX_MASTERY_RATIO} and {@link learningRate}.
 * Past this you keep learning, at a rate that halves for every doubling.
 */
export function trainingCeiling(requirement: number): number {
  return Math.floor(requirement * MAX_MASTERY_RATIO);
}

/**
 * How much of the usual experience a weapon is still worth to you, as a fraction
 * of 1.
 *
 * Full rate until you have outgrown it, then `1/x`: at twice the ceiling you
 * learn half as much, at four times a quarter, and it never quite reaches
 * nothing. The point is pacing rather than prohibition — grinding a starter
 * sword to 100 should be possible and absurd, not impossible.
 *
 * **The other direction is deliberately not here.** A weapon far *above* you
 * already teaches you less, because experience comes from landing blows and you
 * land far fewer of them — see `./battler`'s `hitChanceFrom`. Discounting it a
 * second time here would be charging twice for the same difficulty.
 *
 * A weapon asking nothing teaches at full rate forever, which is what makes a
 * requirement-free weapon the thing that gets a mastery off zero.
 */
export function learningRate(masteryLevel: number, requirement: number): number {
  if (requirement <= 0) return 1;
  const ratio = masteryLevel / requirement;
  if (ratio <= MAX_MASTERY_RATIO) return 1;
  return MAX_MASTERY_RATIO / ratio;
}

const masteryLevelSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_MASTERY),
  v.maxValue(MAX_MASTERY),
);

/**
 * Every mastery optional, so a block says only what it has an opinion about.
 *
 * Built from {@link MASTERIES} rather than written out, which is what stops a
 * mastery added to the union from being silently unparseable. Shared by the
 * battler block and by a weapon's requirements, which are the same shape asking
 * two different questions — "this is what I am good at" and "this is what I ask
 * of you".
 */
export const masteriesSchema = v.object(
  Object.fromEntries(
    MASTERIES.map((mastery) => [mastery, v.optional(masteryLevelSchema)]),
  ) as Record<Mastery, v.OptionalSchema<typeof masteryLevelSchema, undefined>>,
);
