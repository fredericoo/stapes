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

/**
 * What a body has earned towards each mastery, in raw experience.
 *
 * The same shape as {@link Masteries} and emphatically not the same numbers:
 * these are the total worth of everything that mastery has ever done, and the
 * level is read out of them by {@link levelForXp}. Sparse on the same terms, and
 * an absent key is a mastery nothing has ever been earned towards.
 *
 * **Only a player has one.** A creature's masteries are authored and fixed —
 * nothing writes to a rat — which is also why the learning falloff has no work
 * to do on that side.
 */
export type MasteryXp = Partial<Record<Mastery, number>>;

/**
 * Experience the first point of any mastery costs.
 *
 * The whole curve is this times the square of the level, so the *n*th point
 * costs `2n − 1` firsts: the second point costs three of these, the tenth
 * nineteen, the hundredth a hundred and ninety-nine.
 *
 * **Quadratic rather than linear, because Rating makes the top of the scale
 * matter more than the bottom.** Half of R is the best weapon mastery, so a
 * linear curve would let a player's ⭐ climb at a constant rate for ever and
 * outrun every creature the world has; on this one each point costs more than
 * the last, which is what makes the ladder something a player climbs rather than
 * a number that accrues.
 *
 * Four, so that a fresh player who is landing blows on rats feels the first
 * point of Blade in about a dozen kills — near enough to the fight that caused
 * it to read as cause and effect, and far enough that it is not confetti.
 */
export const XP_FOR_FIRST_LEVEL = 4;

/** Total experience a mastery has to have accrued to stand at this level. */
export function xpForLevel(level: number): number {
  return XP_FOR_FIRST_LEVEL * level * level;
}

/**
 * The level this much experience comes to, which is the inverse of
 * {@link xpForLevel} and floored: experience part-way to the next point buys
 * nothing until it is all the way there.
 *
 * Capped at {@link MAX_MASTERY}, so experience past the top of the scale is
 * spent rather than banked. That is deliberate — a mastery that kept counting
 * invisibly past 100 would be a player wondering why nothing was happening.
 */
export function levelForXp(xp: number): number {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / XP_FOR_FIRST_LEVEL));
  return Math.min(MAX_MASTERY, level);
}

/** Every mastery in a block, read out of what has been earned towards it. */
export function masteriesFromXp(xp: MasteryXp): Masteries {
  const masteries: Masteries = {};
  for (const mastery of MASTERIES) {
    const level = levelForXp(xp[mastery] ?? 0);
    if (level > MIN_MASTERY) masteries[mastery] = level;
  }
  return masteries;
}

/**
 * The experience a body would need to stand exactly where it was authored.
 *
 * **What a new player starts with.** The authored block on the `player` tile is
 * a starting point rather than a floor, and seeding it as experience is what
 * makes that literally true: from the first tick the player's masteries are
 * derived from one number apiece and nothing has to reconcile "what you were
 * given" against "what you have earned".
 *
 * It also means re-authoring the tile moves where new players begin and leaves
 * everybody else exactly where they are, which is the honest answer — what a
 * mastery records is that something already happened.
 */
export function xpFromMasteries(masteries: Masteries): MasteryXp {
  const xp: MasteryXp = {};
  for (const mastery of MASTERIES) {
    const level = masteryLevel(masteries, mastery);
    if (level > MIN_MASTERY) xp[mastery] = xpForLevel(level);
  }
  return xp;
}

/**
 * What each of the fighting three is worth to a body's Rating.
 *
 * **The fighting three only, and the weights sum to one.** Summing to one is
 * what puts R on the mastery scale rather than on a second scale nobody has
 * learnt: a body with 40 in everything rates 40, so `Rat (⭐7)` says the rat's
 * masteries come out around seven and needs no further explanation.
 *
 * Breadth is deliberately free. Only the *best* weapon mastery counts, so
 * training a bow alongside a sword costs nothing in every fight you have with
 * the sword — under a flat sum, hyper-specialisation would be the only sane way
 * to play.
 */
export const RATING_PER_BEST_WEAPON = 0.5;
export const RATING_PER_TOUGHNESS = 0.3;
export const RATING_PER_AGILITY = 0.2;

/**
 * The lowest anything that fights can rate.
 *
 * Rating is a divisor — see {@link experienceMultiplier} — and a body with
 * nothing trained at all would otherwise make every fight in the world infinitely
 * rewarding. One rather than a guard at the call site, because "there is no such
 * thing as a rated-zero fighter" is a fact about the scale and belongs on it.
 */
export const MIN_RATING = 1;

/**
 * How good this body is at fighting, all in.
 *
 * **Computed from raw masteries and never from equipment**, which is
 * load-bearing rather than a simplification. If gear counted, stripping naked
 * would lower R, raise the ratio every reward is scaled by, and become the
 * optimal way to farm. Raw masteries only ever go up, and nothing a player can
 * do in the moment moves them.
 *
 * Rounded, because this is the number shown as ⭐ and a rating of 8.6 invites
 * the reader to look for the missing tenth.
 */
export function rating(masteries: Masteries): number {
  let bestWeapon = 0;
  for (const mastery of WEAPON_MASTERIES) {
    bestWeapon = Math.max(bestWeapon, masteryLevel(masteries, mastery));
  }
  const raw =
    RATING_PER_BEST_WEAPON * bestWeapon +
    RATING_PER_TOUGHNESS * masteryLevel(masteries, "toughness") +
    RATING_PER_AGILITY * masteryLevel(masteries, "agility");
  return Math.max(MIN_RATING, Math.round(raw));
}

/**
 * Below this share of your own Rating, a fight is worth nothing at all.
 *
 * A cliff rather than an asymptote, and stated as nothing on purpose: the curve
 * below would pay 0.4% here, and a payout that small does not read as a small
 * payout, it reads as a bug.
 */
export const NOTHING_BELOW_RATIO = 0.5;

/**
 * How sharply a fight beneath you stops being worth having.
 *
 * Eight is steep — something 70% of your Rating pays 6% — and steep is the
 * point. Grinding things beneath you has to be genuinely worthless, or it is
 * simply the safest way to play and everybody does it.
 */
export const BENEATH_YOU_EXPONENT = 8;

/**
 * The most any single fight can be worth, however far above you it is.
 *
 * Reached around `r = 1.4`, so there is a real band worth reaching for and no
 * meta in which the whole game is cheesing one impossible monster.
 */
export const MAX_XP_MULTIPLIER = 2;

/**
 * What a fight against this body is worth, as a multiple of the plain rate.
 *
 * Continuous at parity — both arms give exactly 1 — and the two arms are shaped
 * differently on purpose. Below you it falls away as an eighth power, because
 * the danger falls away that fast too. Above you it is merely quadratic and
 * capped, because the risk is already its own incentive and does not need
 * paying for twice.
 */
export function experienceMultiplier(
  theirRating: number,
  yourRating: number,
): number {
  const r = theirRating / Math.max(MIN_RATING, yourRating);
  if (r < NOTHING_BELOW_RATIO) return 0;
  if (r <= 1) return r ** BENEATH_YOU_EXPONENT;
  return Math.min(MAX_XP_MULTIPLIER, r * r);
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

/**
 * Experience earned, not a level: any finite amount from nothing upwards.
 *
 * Fractional and unbounded above, unlike {@link masteriesSchema}, because it is
 * an accumulator rather than a position on a scale — a blow worth a tenth of a
 * point is a real payout, and the cap belongs on the level read out of this
 * rather than on the total itself.
 */
const masteryXpSchema = v.pipe(v.number(), v.finite(), v.minValue(0));

/**
 * A stored block of earned experience, checked rather than trusted.
 *
 * The one place a mastery arrives from outside this process — durable storage,
 * written by an older build with a mastery that has since been renamed, or by a
 * bug. A block that does not parse reads as no experience at all, which loses a
 * player their progress and is still the right answer: the alternative is a NaN
 * propagating through every fight they have from then on.
 */
export const masteryXpBlockSchema = v.object(
  Object.fromEntries(
    MASTERIES.map((mastery) => [mastery, v.optional(masteryXpSchema)]),
  ) as Record<Mastery, v.OptionalSchema<typeof masteryXpSchema, undefined>>,
);
