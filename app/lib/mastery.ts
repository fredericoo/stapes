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
 *
 * `sharp` was `blade`, and the rename is about what the mastery names. It is
 * read off the *attacker's* weapon on every blow and it keys an armour's
 * resistances — see `../game/combat`'s `defenceAgainst` — so a bear's claws and
 * a wolf's teeth answer to it as much as a sword does. `blade` described the
 * object a swordsman holds, and left every natural weapon in the world filed
 * under a noun none of them are.
 *
 * Nothing migrates a saved `blade`. A stored block is parsed rather than
 * trusted — see `masteryXpBlockSchema` — and an unknown key is dropped, so a
 * player who trained it before this rename starts that mastery again.
 */
export type WeaponMastery = "fist" | "sharp" | "blunt" | "ranged" | "arcane";

/**
 * The masteries nothing is held to practise.
 *
 * Earned by being in a fight rather than by swinging in one: toughness from
 * taking blows, agility from avoiding them. Having no gear to train against is
 * the design rather than a gap: these two are the body itself, so they are
 * weighed against the Rating where a weapon mastery is weighed against itself —
 * you cannot be a novice at having a body. See `docs/notes.md`'s *A mastery is
 * weighed against itself, and a blow against what the body had left*.
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

export const WEAPON_MASTERIES: WeaponMastery[] = ["fist", "sharp", "blunt", "ranged", "arcane"];

export const BODY_MASTERIES: BodyMastery[] = ["toughness", "agility"];

export const MASTERIES: Mastery[] = [...WEAPON_MASTERIES, ...BODY_MASTERIES, ...ELEMENTS];

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
  sharp: "Sharp",
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
 * Whether every mastery this stone asks for has been earned.
 *
 * **All of them, and met exactly rather than scaled**, which is the one place a
 * stone and a weapon part company. A weapon half-understood still swings — see
 * {@link requirementShare}, which turns a shortfall into clumsiness rather than
 * into a refusal — because swinging is a body doing what bodies do. A stone
 * either answers you or it does not, and a spell that fired at a third strength
 * would be a thing a player has to measure to learn about.
 *
 * Requirements on masteries the stone does not train are honoured on exactly the
 * terms a weapon's are: what a Stone of Flame *teaches* is Arcane, and what it
 * takes to hold one steady may be something you go and get elsewhere.
 */
export function meetsRequirements(
  masteries: Masteries,
  requirements: Masteries | undefined,
): boolean {
  if (!requirements) return true;
  return MASTERIES.every(
    (mastery) => masteryLevel(masteries, mastery) >= (requirements[mastery] ?? 0),
  );
}

/**
 * How much of what a weapon asks this body actually brings, as a fraction of 1.
 *
 * **Pooled across every requirement, and capped at each one.** A maul asking
 * Blunt 33 and Toughness 15 asks for forty-eight points in total; a wielder with
 * Blunt 33 and Toughness 8 brings forty-one of them, and is 85% of the way
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
 * How many points of requirement this body is missing, pooled across every
 * mastery a weapon asks for.
 *
 * **Points, not a proportion, and the difference is the whole reason this
 * exists beside {@link requirementShare}.** A share answers "how far along am
 * I", which is the right question for a progress bar and the wrong one for a
 * handicap: two points short of Sharp 10 is a share of 0.80 and two points
 * short of Sharp 33 is 0.94, so a curve steep enough to make the first hurt is
 * far too steep for a weapon seven points out of reach. Counting the points
 * makes "two short" mean the same thing wherever a player is standing, which is
 * what a ladder needs — see `./battler`'s {@link weaponHandling}, the one caller.
 *
 * Pooled and capped on exactly the terms the share is: a maul asking Blunt 33
 * and Toughness 15 wanted from a wielder with Blunt 33 and Toughness 8 is seven
 * points short, and a surplus of Blunt cannot pay for the missing Toughness
 * because each requirement is counted on its own.
 *
 * Zero for a weapon that asks nothing, which is bare hands and every natural
 * weapon: nothing to be short of.
 */
export function requirementShortfall(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  if (!requirements) return 0;

  let missing = 0;
  // Indexed rather than `for...of`, for the reason in `../game/equipment`'s
  // `armorDefence`.
  for (let i = 0; i < MASTERIES.length; i++) {
    const mastery = MASTERIES[i]!;
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    // Per requirement, so a surplus in one cannot cover a shortfall in another —
    // the same reason `requirementShare` caps what each one contributes.
    missing += Math.max(0, required - masteryLevel(masteries, mastery));
  }
  return missing;
}

/**
 * How much of what a stone asks this body brings, as a fraction of 1, **with the
 * surplus counted**.
 *
 * {@link requirementShare} with the cap taken off, and the pair is the whole of
 * the difference between a weapon and a stone. A weapon's requirements are a
 * gate: meeting them is worth everything and exceeding them is worth nothing —
 * see {@link REQUIREMENTS_MET}, which is where that argument is written down. A
 * stone's are a gate *and* a dial, because a cast takes time and what shortens
 * it is how far past the requirement the caster has got. Somebody bringing 110%
 * of what a stone asks casts it in 90% of the time. @see `../game/casting`'s
 * `castDurationMs`
 *
 * Pooled across every requirement on the same terms, and uncapped on both sides
 * of each: a stone asking Arcane 5 and Fire 1 asks for six points, and Arcane 8
 * with Fire 1 brings nine of them. Surplus carrying *is* the point here, so
 * there is no `min` — which also means a caster can pay for a shortfall in one
 * requirement with a surplus in another, as far as this function is concerned.
 * Nothing is cast on that basis: a shortfall anywhere refuses the cast outright,
 * through {@link meetsRequirements}, long before this is asked.
 *
 * A stone that asks nothing is {@link REQUIREMENTS_MET}, so it takes exactly as
 * long as it is authored to take however good the caster is. That is the honest
 * answer rather than a special case: there is nothing to have outgrown.
 */
export function requirementCoverage(
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
    brought += masteryLevel(masteries, mastery);
  }

  if (asked === 0) return REQUIREMENTS_MET;
  return brought / asked;
}

/*
 * Nothing here scales experience by what you are holding, and a `learningRate`
 * used to: `(requirement / your level)` cubed, so a weapon carried past twice
 * its requirement paid an eighth of the usual rate. It charged a player twice
 * for one choice. A weapon low enough to have been outgrown is already the
 * weaker weapon, and experience is counted in damage dealt, so the weaker
 * weapon was already paying less — the falloff took a second bite out of the
 * same fact and left putting the thing down as the only way to keep earning.
 *
 * The brake that remains is the one that was always doing the real work:
 * {@link experienceMultiplier} pays nothing for a fight beneath the mastery
 * being trained — see {@link standingIn} for what "beneath" is measured against.
 * It is keyed to what you are fighting rather than to what you are gripping, so
 * a player who wants Sharp 33 on a rusty sword may have it and has to keep
 * finding harder things to swing at to get there.
 *
 * See `../game/experience`'s `attackerEarnings` and `casterEarnings`, which pay
 * the plain rate.
 */

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
 * point of Sharp in about a dozen kills — near enough to the fight that caused
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
export function experienceMultiplier(theirRating: number, yourRating: number): number {
  const r = theirRating / Math.max(MIN_RATING, yourRating);
  if (r < NOTHING_BELOW_RATIO) return 0;
  if (r <= 1) return r ** BENEATH_YOU_EXPONENT;
  return Math.min(MAX_XP_MULTIPLIER, r * r);
}

/**
 * What a fight is weighed against, for one mastery.
 *
 * **A mastery you practise with something in your hand is weighed against
 * itself; the two that are just your body are weighed against your Rating.**
 * That split is the whole rule, and it is the difference between a skill and a
 * physique.
 *
 * A Blunt 80 veteran who has never held a blade is a novice swordsman. A rat is
 * a fair opponent for that — not for them, for their Sharp — and under a single
 * body Rating it paid them nothing, so there was no way into a second weapon
 * except to take a fresh mastery into fights already pitched at everything else
 * they had. Weighing Sharp 7 against a rat's ⭐8 says the true thing: this is a
 * fight at the level of the skill being practised.
 *
 * **Toughness and Agility get the Rating, because you cannot be a novice at
 * having a body.** A rat's bite teaches a tough body nothing however little
 * Toughness it has trained, and the reason is not its Rating — it is that the
 * bite does not hurt. Half of Rating is those two between them, so weighing them
 * against it is very nearly weighing them against themselves, and
 * `../game/experience`'s `threatRate` already asks the sharper question of
 * whether the blow could dent you at all.
 *
 * **A mastery left untrained is farmable now, and that is the feature rather
 * than the price.** A single body Rating prevented it on purpose — the argument
 * was that sandbagging must never pay — and the argument was too broad. What it
 * was protecting against is a maxed player farming rats for real progress, and
 * that is not what this opens: the farming only works at the bottom of the
 * mastery being trained and stops dead well before it is worth anything. A rat
 * pays nothing once the mastery passes about ⭐24 — see
 * {@link NOTHING_BELOW_RATIO} — and `../game/combat`'s `cappedToHealth` means
 * one rat is worth one rat's health however large the weapon. Nobody sandbags
 * their way to a good sword arm; they sandbag their way to being allowed to
 * start, and finding harder things is still the only way up.
 */
export function standingIn(masteries: Masteries, mastery: Mastery): number {
  return BODY_MASTERIES.includes(mastery as BodyMastery)
    ? rating(masteries)
    : masteryLevel(masteries, mastery);
}

/**
 * What one fight is worth to one mastery, as a multiple of the plain rate.
 *
 * {@link experienceMultiplier} against {@link standingIn} — the pair of them is
 * "how far above or below *this skill* is the thing I am fighting". Every earning
 * path goes through it, so the answer cannot come to differ between a swing and
 * a cast.
 */
export function masteryMultiplier(
  theirRating: number,
  masteries: Masteries,
  mastery: Mastery,
): number {
  return experienceMultiplier(theirRating, standingIn(masteries, mastery));
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
  Object.fromEntries(MASTERIES.map((mastery) => [mastery, v.optional(masteryXpSchema)])) as Record<
    Mastery,
    v.OptionalSchema<typeof masteryXpSchema, undefined>
  >,
);
