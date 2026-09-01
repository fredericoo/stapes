import * as v from "valibot";

import { type Element, ELEMENTS } from "./element";

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

/**
 * An element is a mastery, and that is the whole of how elements got here.
 *
 * **Arcane says how good you are at magic; an element says what you point it
 * at.** You get better at fire by throwing fire, on exactly the terms you get
 * better at blades by swinging one — so the three are numbers on a body like
 * any other, and every block, schema, bar and editor row that walks
 * {@link MASTERIES} picked them up without being asked.
 *
 * **These say what a body can *cast*, and never what it *is*.** What magic does
 * to you when it lands is a different fact, authored on the battler and on what
 * you are wearing — see `./battler`'s `BattlerDef.elements` and
 * `../game/equipment`'s `bodyElements`. Reading it off the masteries instead
 * would make training the element you are best at the thing that makes you weak
 * to its counter, which is a progression that punishes you for progressing; and
 * it would turn a rat that had somehow learnt a little Fire into a fire
 * creature by accident.
 *
 * They are **not** weapon masteries, and the exclusion is load-bearing in one
 * place: {@link rating} counts a body's *best* weapon mastery, so an element in
 * that list would let a caster's ⭐ be their Fire and make a fire specialist
 * read as a better fighter than the identical caster who spread the same
 * practice over three. What Rating measures is Arcane, which is already there
 * and is already the thing every cast trains.
 *
 * @see `./element` for the wheel they sit on.
 */
export type ElementMastery = Element;

export type Mastery = WeaponMastery | BodyMastery | ElementMastery;

export const WEAPON_MASTERIES: WeaponMastery[] = [
  "fist",
  "blade",
  "blunt",
  "ranged",
  "arcane",
];

export const BODY_MASTERIES: BodyMastery[] = ["toughness", "agility"];

export const MASTERIES: Mastery[] = [
  ...WEAPON_MASTERIES,
  ...BODY_MASTERIES,
  ...ELEMENTS,
];

/**
 * What each mastery is called on screen.
 *
 * **Here rather than in a component, because two of them needed it and neither
 * could have the other's.** The editor's panels and `./weaponDemand`'s inspect
 * lines carried identical tables of the same words — `app/lib` cannot import
 * from `app/components`, so the duplication had nowhere else to go — and a
 * mastery added to the union was two places a rename had to reach. It is the
 * same argument this module exists for: two modules needing the same words is
 * what a third module is for, and the words belong beside the list they name.
 */
export const MASTERY_LABELS: Record<Mastery, string> = {
  fist: "Fist",
  blade: "Blade",
  blunt: "Blunt",
  ranged: "Ranged",
  arcane: "Arcane",
  toughness: "Toughness",
  agility: "Agility",
  fire: "Fire",
  water: "Water",
  nature: "Nature",
};

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
 * Which elements a spell is made of.
 *
 * **Read off the requirements, and that is the only place a spell's element is
 * written down.** A stone asking Fire 1 is a fire spell; one asking Fire 8 and
 * Water 8 is both. There is no second field naming an element, because a second
 * field is a second thing to keep in step — and because what a spell asks of
 * you and what a spell *is* are genuinely the same fact: nobody throws fire
 * without having learnt some.
 *
 * Every element the block names, never the strongest, which is the whole of
 * what "a spell can have more than one element" means — see `./element`'s
 * {@link effectiveness}, which looks at all of them.
 *
 * **This is the casting side only.** What a body counts as when a spell lands
 * on it is authored rather than practised, and is asked elsewhere entirely —
 * see `../game/equipment`'s `bodyElements`.
 *
 * Empty for a stone with no elemental requirement at all, which is an
 * elementless spell: a stone of light is magic that is not made of anything,
 * and it neither gains nor loses on the wheel.
 */
export function spellElements(requirements: Masteries | undefined): Element[] {
  if (!requirements) return [];
  return ELEMENTS.filter((element) => (requirements[element] ?? 0) > 0);
}

/**
 * What a fully-met set of requirements is worth: all of it, and never more.
 *
 * **A gate rather than a scaling term**, which is the whole of the change this
 * replaced. There used to be a `MAX_MASTERY_RATIO` of 1.25 letting a wielder who
 * had outgrown a weapon squeeze a little extra out of it, and it answered the
 * wrong question: being *good with blades* is not the same as *exceeding what
 * this blade asks*, and only the first of those should keep paying. Requirements
 * now say when a weapon unlocks and nothing else; how good you are with it is
 * `./battler`'s separate business.
 */
export const REQUIREMENTS_MET = 1;

/**
 * How much of what a weapon asks this body actually brings, as a fraction of 1.
 *
 * **Pooled across every requirement, and capped at each one.** An axe asking
 * Blunt 35 and Toughness 20 asks for fifty-five points in total; a wielder with
 * Blunt 35 and Toughness 10 brings forty-five of them, and is 82% of the way
 * there. Surplus never carries — `min(required, level)` — so a Blunt 100 brute
 * with no Toughness cannot muscle their way past the half of the weapon that is
 * about being able to hold it.
 *
 * **This used to be the worst single requirement**, and pooling is a softer and
 * more legible rule: under the old one, being one point short of a secondary
 * requirement halved the weapon outright, which read to a player as the weapon
 * being broken rather than as them being short. Pooling makes partial progress
 * visible — every point put in moves the number — while the cap keeps each
 * requirement genuinely required.
 *
 * A requirement of zero is not a requirement, and a weapon that asks nothing at
 * all is {@link REQUIREMENTS_MET}: bare hands should not be worse than a sword
 * for being simpler.
 */
export function requirementShare(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  if (!requirements) return REQUIREMENTS_MET;

  let asked = 0;
  let brought = 0;
  for (const mastery of MASTERIES) {
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    asked += required;
    // Capped at what this requirement asked, so a surplus here cannot stand in
    // for a shortfall somewhere else.
    brought += Math.min(required, masteryLevel(masteries, mastery));
  }

  if (asked === 0) return REQUIREMENTS_MET;
  return brought / asked;
}

/**
 * How sharply a weapon stops teaching you once you have passed what it asks.
 *
 * **Six, and the steepness is the whole design.** A fifth past the requirement
 * already pays a third of the rate; twice the requirement pays a sixtieth. The
 * intent is that you cannot grind one mastery on one weapon: the thing that
 * makes you better is picking up the next weapon up, so a player who wants to
 * climb has to keep moving rather than keep swinging.
 *
 * It replaced a five-point bridge followed by a gentle `ceiling / level` fade,
 * which was far too generous to stand still on — a starter sword taken to
 * mastery 100 was slow but perfectly viable, and "viable" is all a grind needs
 * to be.
 */
export const OUTGROWN_FALLOFF = 6;

/**
 * How much of the usual experience a weapon is still worth to you, as a fraction
 * of 1.
 *
 * `(requirement / your level)` raised to {@link OUTGROWN_FALLOFF}, and **held at
 * full rate anywhere at or below the requirement**. The cap is the important
 * half: below what a weapon asks the ratio is greater than one, and paying a
 * *bonus* for swinging something you cannot use would be exactly backwards.
 *
 * **The other direction is deliberately not discounted.** A weapon far above you
 * already teaches you less, because experience comes from landing blows and you
 * land far fewer of them — see `./battler`'s `weaponReadiness`, which now drags
 * damage down too, and damage is what experience is counted in. Discounting it a
 * second time here would be charging twice for the same difficulty, and it is
 * what deadlocked the old training wall.
 *
 * A weapon asking nothing teaches at full rate forever, which is what makes a
 * requirement-free weapon — bare hands — the thing that gets a mastery off zero.
 *
 * **Only the weapon's own mastery is ever consulted**, by the one caller there
 * is: see `../game/experience`'s `attackerEarnings`, which looks up
 * `requirements[weapon.mastery]` and credits that mastery alone. An axe asking
 * Blade 8 and Toughness 20 is a Blade weapon that is also heavy; leaving
 * Toughness untrained must not turn it into a Blade trainer that never stops
 * paying.
 */
export function learningRate(masteryLevel: number, requirement: number): number {
  if (requirement <= 0) return 1;
  if (masteryLevel <= requirement) return 1;
  return (requirement / masteryLevel) ** OUTGROWN_FALLOFF;
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

/**
 * How far this much experience has come towards the next point, as a fraction
 * of 1.
 *
 * What a progress bar draws, and the reason the raw experience is what travels
 * rather than the level: a bar that could only move when the level did would sit
 * still for a dozen fights and then jump, which reads as nothing happening
 * rather than as progress.
 *
 * Zero at the top of the scale, where there is no next point to be part of the
 * way to. A bar creeping towards a level that cannot arrive is worse than no bar.
 */
export function progressToNextLevel(xp: number): number {
  const level = levelForXp(xp);
  if (level >= MAX_MASTERY) return 0;
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return Math.max(0, Math.min(1, (Math.max(0, xp) - from) / (to - from)));
}

/**
 * Whether this block records anything at all.
 *
 * **An empty block is not a body with nothing learnt — it is a body nobody has
 * asked about yet**, and the difference is the whole of somebody's character.
 * Seeding is gated on the block being *absent*, so an empty one restored from
 * storage slips past the gate and sticks: every mastery reads zero, and a player
 * comes back with eight hit points instead of sixteen, no evasion, and a sword
 * they can no longer swing.
 *
 * There is no legitimate empty block. A seeded one is never empty for any body
 * an author gave masteries to, and one that genuinely would be empty seeds to
 * empty again — so treating it as absent costs nothing and closes the hole.
 */
export function hasExperience(xp: MasteryXp | undefined): xp is MasteryXp {
  if (!xp) return false;
  for (const mastery of MASTERIES) {
    if ((xp[mastery] ?? 0) > 0) return true;
  }
  return false;
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
 * **The fighting three only, and the weights sum to one.** The elements are
 * deliberately not among them — see {@link ElementMastery}, where the reason
 * is written down: Arcane already measures how good a body is at magic, and an
 * element in the best-weapon term would make specialising in one look like
 * being better at fighting than spreading the same practice over three.
 *
 * Summing to one is what puts R on the mastery scale rather than on a second
 * scale nobody has learnt: a body with 40 in everything rates 40, so `Rat (⭐7)` says the rat's
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
 * How a Rating is written, wherever one is shown.
 *
 * An asterisk, and not the star it obviously wants to be: the world's text is
 * typeset in NF Pixels, which is subset to printable ASCII — see
 * `public/fonts/` and `../net/chat`, which drops anything outside that range for
 * the same reason. A ⭐ has no glyph there, so the browser falls back to a colour
 * emoji at the wrong metrics, sitting in a name tag drawn at two CSS pixels per
 * font pixel. It reads as a bug because it is one.
 *
 * The panels are typeset in a different face that *could* draw the star, and
 * they use this anyway: a ⭐ over a head and a star in a menu that are two
 * different shapes are two different numbers as far as a reader is concerned.
 */
export const RATING_GLYPH = "*";

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
 * below pays 0.4% here, and a payout that small does not read as a small
 * payout, it reads as a bug.
 *
 * **A third rather than a half, because it is tied to
 * {@link BENEATH_YOU_EXPONENT} and follows it.** The cliff has to land where the
 * curve has already fallen to nothing-in-all-but-name; softening the exponent
 * lifts the whole curve, so the same figure now arrives further down. Leaving it
 * at a half would have put a visible 3% step at the edge, which is precisely the
 * thing this constant exists to avoid.
 */
export const NOTHING_BELOW_RATIO = 1 / 3;

/**
 * How sharply a fight beneath you stops being worth having.
 *
 * Five, and it was eight. Eight was steep on purpose — grinding things beneath
 * you has to be genuinely worthless, or it is simply the safest way to play and
 * everybody does it — but at eight the fall was so fast that Rating *rounding*
 * became the loudest event in a player's progression. A starter target paid 0.39
 * at ⭐9 and 0.17 at ⭐10, and nothing about the player changed in between except
 * a rounded number ticking over. That reads as a punishment for levelling up.
 *
 * At five the same step is 0.55 to 0.33: the first safe thing a player finds
 * stays worth fighting for a few points of progress rather than one, and the
 * incentive to move up the ladder survives, because something at your own
 * Rating still pays three times what something at 70% of it does.
 */
export const BENEATH_YOU_EXPONENT = 5;

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
