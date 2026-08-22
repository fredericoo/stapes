import * as v from "valibot";
import {
  DEFAULT_WEAPON,
  MAX_PERCENT_STAT,
  MELEE_REACH,
  type ProjectileDef,
  type Reach,
  weaponSchema,
  type WeaponItem,
  type WeaponResistances,
  type WeaponStatus,
} from "./item";
import { type Kit, kitSchema } from "./kit";
import {
  type Masteries,
  masteriesSchema,
  masteryLevel,
  MAX_MASTERY,
  requirementShare,
  type WeaponMastery,
} from "./mastery";
import type { TileDef } from "./types";

/**
 * What it takes to be hit, and to hit back.
 *
 * Authored on the tile def beside the other interaction blocks, and parsed
 * rather than trusted on exactly the terms `push` and `brain` are: a malformed
 * block reads as "not a battler", never as a crashed world.
 *
 * ## Nothing here is a stat any more
 *
 * This used to be six numbers — `maxHp`, `atk`, `def`, `acc`, `flee`, `spd` —
 * and the argument for six rather than two was that each answered a question the
 * others could not. That argument was right and it still holds; what changed is
 * *where the answers come from*. A body now carries masteries and a natural
 * weapon, and all six fall out of those. See {@link FightingStats}.
 *
 * The two fields that survived did so because they fail the mastery test: they
 * would not improve with practice. A rat that has bitten a thousand things has
 * the same jaw and the same habit of not looking up.
 *
 * Being a battler is not the same as being an actor. A battler is anything with
 * hit points — the player, a cat, and in time a barrel worth smashing. What
 * *drives* it is `./brain`'s question, and a body may perfectly well have one,
 * the other, both or neither.
 */
export type BattlerDef = {
  /**
   * What this body is good at. Authored and fixed on a creature; earned and
   * stored per actor on a player.
   */
  masteries: Masteries;
  /**
   * What this body fights with when its hands are empty — a bite, a claw, a
   * pair of fists.
   *
   * **Every battler has one, and that is the point.** It is what preserves the
   * axis that pure masteries destroy: a rat's bite is authored fast and light, a
   * snake's slow and heavy, and Fist decides only how well each animal uses what
   * it has. Derive damage and speed from one mastery number instead and the
   * harder-hitting animal is the faster one by construction — there is no way to
   * write a rat that is not simply a smaller snake.
   *
   * A held weapon *replaces* this rather than adding to it. See
   * `../game/equipment`.
   */
  naturalWeapon: WeaponItem;
  /**
   * Floors this creature bothers to look up and down.
   *
   * **A fact about the creature, not about the world.** Whether anything is in
   * the way is geometry and is asked separately — see `../game/sight`. This is
   * the other half: a rat with `{ up: 0, down: 0 }` standing in the open does
   * not notice you on the ledge above it, not because it cannot see through the
   * air but because it does not look. That is a characterisation, and it is the
   * dial that makes a hawk different from a rat rather than just better at it.
   *
   * Zero by default, so an authored creature minds its own floor until somebody
   * decides otherwise.
   */
  sight: { up: number; down: number };
  /**
   * What this body is born carrying. See `./kit`, which owns the shape and the
   * parsing.
   *
   * On the battler rather than beside it, because equipment is now something
   * *every* body has and only a battler has a body — the player's backpack and
   * a rat's mouthful of meat are the same field on the same block. What turns a
   * kit into an `Equipment` is `../game/battlerKit`, which rolls it once, when
   * the body is instantiated.
   *
   * Optional, and absent reads as "carries nothing" — which is every creature
   * that predates this. Optional rather than an always-written empty array
   * because `interactionsForSave` omits it when it is empty, and a type that
   * promised more than the file holds would be a promise every reader has to
   * check anyway. `resolveBattler` fills it, so anything downstream of a parse
   * sees a list.
   */
  kit?: Kit;
};

/**
 * The numbers a fight is actually fought with.
 *
 * Derived from a body and whatever it is holding, never authored and never
 * stored. Everything downstream — the swing, the cooldown, the health bar's
 * maximum — reads this and not {@link BattlerDef}, which is what let masteries
 * replace the authored stats without the engine below noticing: one function
 * changed, at `../game/GameSession`'s `battlerOf`.
 *
 * The field names are the old authored ones on purpose, except `atk`, which
 * became {@link damage} because it is no longer an increment to anything.
 */
export type FightingStats = {
  /** Hit points a fresh instance of this body starts at. */
  maxHp: number;
  /**
   * The most damage one blow can do, against a foe with no {@link def}.
   * A ceiling rather than an average — see `../game/combat`.
   */
  damage: number;
  /**
   * Flat reduction on every blow that lands, whatever kind of blow it was.
   *
   * The unconditional half of defence. What a particular blow actually has to
   * get through is this plus whatever {@link resist} says about *that* kind —
   * see `../game/combat`'s `defenceAgainst`, which is the one place the two are
   * put together.
   */
  def: number;
  /**
   * Extra reduction against blows of one kind, from what this body is wearing.
   *
   * Carried on the resolved stats rather than looked up off the armour at the
   * moment of the blow, on exactly the terms {@link statuses} and
   * {@link projectile} are: the fight already holds both bodies resolved, and a
   * second trip to the tile catalogue from inside `rollAttack` would be a second
   * answer that can disagree with this one.
   *
   * Empty for a body wearing nothing and for armour with no opinion, which is
   * most of them — see {@link NO_RESISTANCES}.
   */
  resist: WeaponResistances;
  /**
   * 0–100. How reliably this finds its target.
   *
   * Half of {@link hitChance}, and what a defender's {@link flee} is contested
   * against. It no longer says anything about how much a connecting blow is
   * worth — that is {@link variance}.
   */
  accuracy: number;
  /** 0–100. How much a connecting blow varies, as a share of {@link damage}. */
  variance: number;
  /** 0–100. How often this body can swing. See `../game/combat`. */
  spd: number;
  /**
   * What kind of blow this body strikes — its weapon's mastery.
   *
   * **Here so a blow can say what it is**, which is what armour keyed by kind
   * needs of the attacking side: the defender's {@link resist} is a table and
   * this is the key read out of it. It is the weapon's own field carried
   * through untouched, never the wielder's best mastery — a novice swinging a
   * sword is still striking with a blade, and mail should turn it aside on the
   * same terms it turns aside an expert's.
   */
  mastery: WeaponMastery;
  /**
   * How much faster than {@link spd} alone this body swings — Agility's doing.
   *
   * A multiplier on the rate rather than a term in {@link spd}, and that is
   * load-bearing: `spd` is a position on a geometric curve that tops out at 100,
   * so a body three times as fast as a maxed weapon has no `spd` to say so with.
   * It is applied where the interval is worked out — `../game/combat`'s
   * `swingIntervalMs` — so the result is still a whole number of ticks.
   *
   * One for a body with no Agility, which is every authored creature that has
   * not been given any.
   */
  haste: number;
  /**
   * The chance a swing connects with anything at all, as a fraction of 1.
   *
   * The weapon's own {@link accuracy} multiplied by how well its wielder meets
   * what it asks — see {@link hitChanceFrom}. **The attacker's own failure, and
   * never the defender's skill**, which is what keeps it a separate question
   * from {@link flee}: a miss earns nobody anything, where a dodge is the
   * defender's Agility paying off.
   */
  hitChance: number;
  /**
   * 0–100. Evasion, contested against the attacker's {@link accuracy} on a
   * logistic curve — see `../game/combat`'s `dodgeChance`. Level pegging is a
   * coin toss, and neither end ever reaches certainty.
   */
  flee: number;
  /**
   * How far this body's blow carries — the weapon's, not the body's.
   *
   * It used to be {@link BattlerDef.range}, authored on the tile, and that field
   * is gone rather than deprecated. A body has no reach of its own: bare hands
   * are a weapon, a bite is a weapon, and each carries the distance it works at.
   * A rat that picks up a bow shoots as far as the bow carries.
   */
  reach: Reach;
  /**
   * What this body's weapon puts in the air, or null for one that reaches its
   * target itself.
   *
   * Carried here rather than looked up again where it is needed, because the two
   * things that read it — whether to lean, and what to draw in flight — both run
   * on the tick of a swing that has already resolved the weapon once. Asking the
   * catalogue twice is how the lean and the arrow come to disagree about whether
   * a blow was a shot.
   */
  projectile: ProjectileDef | null;
  sight: { up: number; down: number };
  /**
   * What a connecting blow may leave on whoever it lands on.
   *
   * The weapon's own list, carried through untouched — the mastery ratio scales
   * the three numbers a blow is worth and deliberately stops there. See
   * `./item`'s {@link WeaponItem.statuses} for why venom is not a skill.
   *
   * Here rather than read off the weapon at the point of the swing so that
   * *what a body fights with* stays one question with one answer: a snake
   * biting and a player wielding a fang taken off its corpse go down the same
   * path, and the second case is free rather than something anybody has to
   * remember to wire up.
   */
  statuses: readonly WeaponStatus[];
};

/**
 * Hit points a body has before Toughness adds any.
 *
 * Not zero, because a mastery of zero is a novice rather than a corpse: a fresh
 * body with nothing trained still has to survive long enough to train it.
 */
export const BASE_HP = 8;

/**
 * Hit points the **first** point of Toughness is worth.
 *
 * The first rather than every one, because the curve accelerates — see
 * {@link MASTERY_ACCELERATION}. One, which is what every point used to be
 * worth, so nothing authored today loses anything at the bottom of the scale.
 */
export const HP_PER_TOUGHNESS = 1;

/**
 * How much more the last point of a mastery is worth than the first.
 *
 * **Toughness used to be flat, and flat is what made it the only mastery worth
 * training and never worth finishing.** A hundredth point that pays exactly what
 * the first paid is a hundredth point nobody feels, so the top of the scale was
 * a grind with no moment in it. Three means the climb from 99 to 100 is worth
 * three times the climb from 0 to 1, and the whole stretch in between rises
 * smoothly rather than in steps.
 *
 * Shared by everything a body mastery buys — hit points, defence and haste —
 * which is the point of it being one constant. Two masteries that paid out at
 * different paces would make one of them the obvious first hundred points and
 * the other something you got round to.
 */
export const MASTERY_ACCELERATION = 3;

/**
 * Defence the whole of Toughness is worth, at the top of the scale.
 *
 * **Stated as an endpoint rather than as a rate**, unlike hit points, because
 * that is the honest way to think about it: defence is subtracted from every
 * blow that lands, so what matters is what a fully-trained body turns aside, and
 * the rate is whatever gets it there. Twenty is a bite off most things in the
 * world and the whole of a rat's.
 *
 * Before this, **defence came only from a weapon's `def` and every weapon in the
 * world authors zero** — so mitigation was a stat the game had a formula for and
 * no source of. Toughness is the obvious source: it is the mastery that already
 * answers "how much can this body take".
 */
export const DEF_AT_MAX_TOUGHNESS = 20;

/**
 * Flee a body has before Agility adds any.
 *
 * Non-zero for the same reason {@link BASE_HP} is: dodging is contested against
 * the attacker's accuracy, which sits high on most weapons, and a body starting
 * at nothing would spend the whole early game pinned to the floor of the chance
 * band. A mastery that pays nothing until it is a third grown is one nobody can
 * start.
 */
export const FLEE_BASE = 20;

/**
 * Evasion each point of Agility is worth.
 *
 * One, not two, and the difference is where the mastery stops paying. Evasion is
 * contested against an accuracy that sits near 85 on anything worth swinging, on
 * a curve whose whole interesting range is about two {@link CONTEST_SCALE}s wide
 * — so at two per point the entire journey from hopeless to untouchable was over
 * by Agility 40 and the top sixty points of the scale bought nothing at all.
 */
export const FLEE_PER_AGILITY = 1;

/**
 * The narrowest and widest any chance in a fight is allowed to be.
 *
 * **Nothing is ever certain in either direction.** A blow that always lands is
 * not a fight and neither is one that never does; leaving a twentieth either way
 * means an outmatched defender is never simply a target, and a hopeless swing is
 * never simply wasted. It is also what lets a mastery be started at all — a
 * weapon far beyond you still connects sometimes, so it can still teach you.
 *
 * One rule applied to every probability in a fight, which is why hit chance has
 * no floor of its own: two constants doing the same job in different places is
 * one of them being forgotten later.
 *
 * Here rather than in `../game/combat` because `lib` may not reach into `game` —
 * the dependency runs one way, and combat already reads this module for
 * {@link FightingStats}.
 */
export const MIN_CHANCE = 0.05;
export const MAX_CHANCE = 0.95;

/** Hold a probability inside the band nothing in a fight escapes. */
export function clampChance(chance: number): number {
  return Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, chance));
}

/**
 * What a mastery has paid out by the time it reaches this level.
 *
 * A quadratic through the origin, fixed by two facts an author can actually
 * hold in their head: what the whole scale is worth, and how much more the last
 * point is worth than the first. Everything in between follows, and follows
 * *smoothly* — there is no tier, no breakpoint and nothing to memorise, which is
 * what separates a curve that rewards the grind from one that turns it into a
 * series of cliffs.
 *
 * Written as `c·level + d·level²` where `c` is the first point's worth. Solving
 * `total(max) = atMax` and `gain(max) / gain(0) = acceleration` gives both.
 *
 * Floored at zero rather than clamped at the top: a mastery above the scale is
 * `../lib/mastery`'s business to refuse, and a curve that flattened out here
 * would be a second ceiling quietly beating the schema's.
 */
function acceleratingTotal(
  level: number,
  atMax: number,
  acceleration: number,
): number {
  const reach = Math.max(0, level);
  const first = (2 * atMax) / (MAX_MASTERY * (acceleration + 1));
  const curve = (first * (acceleration - 1)) / (2 * MAX_MASTERY);
  return first * reach + curve * reach * reach;
}

/**
 * What the whole of Toughness is worth in hit points.
 *
 * Derived from the first point's worth rather than authored beside it, because
 * the number an author has an opinion about is "a point of Toughness is worth an
 * HP" — the top of the scale is then whatever the acceleration makes of it,
 * rather than a second figure that has to be kept in step with the first.
 */
export const HP_AT_MAX_TOUGHNESS =
  (HP_PER_TOUGHNESS * MAX_MASTERY * (MASTERY_ACCELERATION + 1)) / 2;

/**
 * Hit points a body with this much Toughness starts at.
 *
 * Rounded to a whole hit point, which is the only unit health is ever counted
 * in — a fractional maximum would put a health bar at 13.25 and a damage number
 * against it that never quite empties it.
 */
export function maxHpFrom(toughness: number): number {
  return (
    BASE_HP +
    Math.round(
      acceleratingTotal(toughness, HP_AT_MAX_TOUGHNESS, MASTERY_ACCELERATION),
    )
  );
}

/**
 * How much every blow that lands on this body is reduced by, from Toughness
 * alone.
 *
 * On the same curve as hit points and for the same reason — see
 * {@link MASTERY_ACCELERATION}. It is deliberately worth almost nothing early:
 * the authored creatures sit between Toughness 3 and 22, so a curve that paid
 * out flatly here would hand every rat in the world enough armour to shrug off
 * the other rats, and turn the opening hour of the game into two bodies unable
 * to hurt each other.
 *
 * **Added to the weapon's `def` rather than replacing it.** A parrying weapon
 * and a shield in the off hand are still what they were; this is the body's own
 * share, and the three sum. Whole numbers, because damage is.
 */
export function defFrom(toughness: number): number {
  return Math.round(
    acceleratingTotal(toughness, DEF_AT_MAX_TOUGHNESS, MASTERY_ACCELERATION),
  );
}

/**
 * How much faster Agility 100 swings than an untrained body: three times the
 * rate, stated as the *bonus* on top of the one it already had.
 *
 * **Speed used to be entirely the weapon's**, which made Agility a stat that
 * only mattered when somebody swung at you — a defensive investment with no
 * answer to "what does this do for me on the attack". A fast body should be fast
 * at both, and the weapon still decides the *shape*: a heavy axe hastened is
 * still slower than a hastened dagger, because this multiplies whatever the
 * weapon's own rate is rather than replacing it.
 *
 * Three times the rate of Agility 0. From Agility *1* it is 2.97 times, because
 * the first point of an accelerating curve is worth almost nothing — which is
 * the curve doing its job rather than the figure being off.
 */
export const HASTE_AT_MAX_AGILITY = 2;

/**
 * How much faster than its weapon's own rate this body swings, as a multiplier.
 *
 * One at Agility 0, so a body that has never trained it swings exactly as fast
 * as whatever it is holding — which is what every body in the world did before
 * this existed, and is why no authored creature changes pace unless somebody
 * gives it Agility.
 */
export function hasteFrom(agility: number): number {
  return (
    1 + acceleratingTotal(agility, HASTE_AT_MAX_AGILITY, MASTERY_ACCELERATION)
  );
}

/**
 * How well a body with this much Agility gets out of the way.
 *
 * **Deliberately unbounded above**, unlike every other percent stat. It used to
 * clamp at 100 because it *was* a probability — the old rule read it as one
 * directly. It is now one side of a contest resolved through a logistic, where
 * a number past 100 is simply further along the curve and the ceiling on the
 * outcome is {@link MAX_CHANCE}. Clamping here would put the ceiling in two
 * places, and the lower one would win silently.
 */
export function fleeFrom(agility: number): number {
  return FLEE_BASE + Math.round(FLEE_PER_AGILITY * agility);
}

/**
 * How steeply a weapon falls off below what it asks.
 *
 * **A weapon’s authored numbers are what it is worth with its requirements
 * *exactly* met** — not a ceiling to be approached, and not a floor to be
 * exceeded. Everything below that is this curve, and cubing it means falling
 * short hurts far more than proportionally: nine tenths of the way there is
 * barely three quarters of the weapon, and half way there is an eighth of it.
 *
 * That shape is the point. A gate that degraded linearly is not a gate — it is
 * a discount, and a player who can have 90% of an endgame weapon for 90% of the
 * work will take it every time. Cubed, an unearned weapon is genuinely bad, so
 * the moment it unlocks is a moment.
 */
export const REQUIREMENT_FALLOFF = 3;

/** What a weapon is worth right now, as a fraction of its authored numbers. */
export function weaponReadiness(share: number): number {
  return Math.max(0, Math.min(1, share)) ** REQUIREMENT_FALLOFF;
}

/**
 * What being good with a weapon adds, over and above being *allowed* to use it.
 *
 * **The half of mastery that requirements deliberately do not cover.** A Blade
 * 100 hero holding a requirement-1 dagger has met that requirement a hundred
 * times over and gets nothing for it from {@link weaponReadiness}, which caps at
 * fully-met. This is what pays them instead, and it is keyed to the *absolute*
 * level of the mastery the weapon answers to rather than to any ratio — so it
 * scales with how good you are, not with how demanding the thing in your hand
 * happens to be.
 *
 * Two terms, and they do different jobs:
 *
 * - **A share of the weapon’s own worth**, so a better weapon rewards mastery
 *   more in absolute terms and the tiers stay ordered.
 * - **A flat amount**, so mastery is worth training even with something small in
 *   your hand, and a starter weapon in expert hands is a real weapon rather than
 *   a rounding error.
 *
 * The flat term is the louder of the two on anything low-tier, which is
 * intended: it is what makes a mastered fist worth having at all.
 */
export const MASTERY_DAMAGE_BONUS = 0.25;
export const DAMAGE_AT_MAX_MASTERY = 20;
export const MASTERY_ACCURACY_BONUS = 0.25;
export const ACCURACY_AT_MAX_MASTERY = 5;

/**
 * The chance a swing connects at all.
 *
 * Now simply the wielder’s accuracy read as a probability, because the two
 * failures it used to multiply have collapsed into one place. Falling short of a
 * weapon’s requirements already drags {@link FightingStats.accuracy} down
 * through {@link weaponReadiness}, and being good with it already pushes that
 * accuracy up — so charging for either a second time here would be charging
 * twice for the same fact.
 *
 * Held inside the band nothing in a fight escapes: a weapon far beyond you still
 * lands one swing in twenty, so it is poor rather than inert and can still teach
 * you; and a master still whiffs one in twenty, because nothing is ever certain.
 *
 * **Accuracy above 100 is meaningful and deliberately not wasted.** It cannot
 * buy more than {@link MAX_CHANCE} here, but it is also what a defender’s
 * evasion is contested against — so a master is harder to dodge as well as
 * harder to escape.
 */
export function hitChanceFrom(accuracy: number): number {
  return clampChance(accuracy / MAX_PERCENT_STAT);
}

/**
 * What a tile gets the moment somebody ticks the Battler box.
 *
 * Middling on purpose, and complete: a fresh battler can fight on the tick it is
 * authored, because a natural weapon of nothing would be a body that swings for
 * zero and reads as broken rather than as a default.
 *
 * Eight across the board puts it just under the deer and just over the rat —
 * squarely in the middle of the ladder the world is authored on, which is what a
 * default is for.
 */
export const DEFAULT_BATTLER: BattlerDef = {
  masteries: { fist: 8, toughness: 8, agility: 8 },
  naturalWeapon: { ...DEFAULT_WEAPON, mastery: "fist", reach: { ...MELEE_REACH } },
  sight: { up: 0, down: 0 },
  // Nothing, because what a body carries is the one part of it an author has to
  // decide: a default sword would arm every creature anybody ticks the Battler
  // box on, and arming things is the whole point of the field.
  kit: [],
};

/**
 * A body and what it is swinging, resolved into numbers.
 *
 * The weapon is passed in rather than read off the body because *which* weapon
 * is not this module's question — a held sword replaces the natural one, and
 * knowing that is `../game/equipment`'s job. This function knows only how a
 * profile plus a set of masteries becomes a fight.
 *
 * The mastery ratio is applied here and nowhere else, which is what keeps "how
 * good are you with this" a single question with a single answer. Three of the
 * weapon's four numbers move with it; `acc` deliberately does not, because it is
 * the damage band rather than the hit chance and the penalty already has a term
 * of its own.
 *
 * Hit points and flee are untouched by the weapon, which is the other half of
 * the split: what a body *is* cannot be picked up or put down.
 */
export function fightingStats(
  battler: BattlerDef,
  weapon: WeaponItem,
): FightingStats {
  // How much of what the weapon asks this body brings, and what the weapon is
  // therefore worth right now. One number, applied to all three of the things a
  // weapon is: falling short makes it weaker, clumsier *and* slower.
  const readiness = weaponReadiness(
    requirementShare(battler.masteries, weapon.requirements),
  );

  // The mastery the weapon itself answers to, read at its absolute level. This
  // is the "you are simply good with blades" term, and it is deliberately not a
  // ratio against the requirement — see {@link MASTERY_DAMAGE_BONUS}.
  const skill = masteryLevel(battler.masteries, weapon.mastery) / MAX_MASTERY;

  // **Readiness gates the skill bonus too, flat part included.** It is the
  // outermost factor rather than something applied to the weapon's own numbers
  // and then added to, and that placement is the whole rule: what mastery buys
  // you is *more out of this weapon*, so a weapon you cannot lift has nothing
  // more to give. Left ungated, the flat term did not depend on the weapon at
  // all — a Blade 100 hero picking up something whose Toughness requirement they
  // could not meet still swung it for twenty, which is a gate with a hole cut in
  // it exactly where the strongest players stand.
  const damage =
    readiness *
    (weapon.damage * (1 + skill * MASTERY_DAMAGE_BONUS) +
      skill * DAMAGE_AT_MAX_MASTERY);
  const accuracy =
    readiness *
    (weapon.accuracy * (1 + skill * MASTERY_ACCURACY_BONUS) +
      skill * ACCURACY_AT_MAX_MASTERY);

  return {
    maxHp: maxHpFrom(masteryLevel(battler.masteries, "toughness")),
    flee: fleeFrom(masteryLevel(battler.masteries, "agility")),
    damage: Math.round(damage),
    // The weapon's own plus the body's, which is the first time defence has had
    // a source that is not a held item — see {@link defFrom}.
    def: weapon.def + defFrom(masteryLevel(battler.masteries, "toughness")),
    // Nothing from the weapon and nothing from the body: resistance is worn, and
    // what a body is wearing is `../game/equipment`'s question. This function
    // knows only a profile and a set of masteries, so it says "none" and
    // `effectiveBattler` fills it in.
    resist: NO_RESISTANCES,
    mastery: weapon.mastery,
    // **Deliberately allowed past 100.** It is a position in a contest against a
    // defender's evasion as well as the input to a hit chance, and the hit
    // chance has a ceiling of its own. Clamping here would put the ceiling in
    // two places and the lower one would win silently — the same reason
    // `fleeFrom` is unbounded above.
    accuracy: Math.round(accuracy),
    hitChance: hitChanceFrom(accuracy),
    variance: weapon.variance,
    // Off the body, not the weapon: how quick you are is yours, and a heavy axe
    // in quick hands is a hastened heavy axe rather than a dagger.
    haste: hasteFrom(masteryLevel(battler.masteries, "agility")),
    // Scaled by readiness like the other two and by nothing else: mastery's
    // reward for speed is Agility's to give, and paying it twice would make a
    // trained blade both harder-hitting and faster for the same points.
    spd: Math.max(0, Math.round(weapon.spd * readiness)),
    // Both off the weapon, not the body — the one place a bow differs from a
    // fist in kind rather than in degree. Untouched by readiness above: a novice
    // archer is worse at hitting what they aim at, and the arrow still flies as
    // far as the bow throws it.
    reach: weapon.reach,
    projectile: weapon.projectile ?? null,
    sight: battler.sight,
    statuses: weapon.statuses ?? NO_WEAPON_STATUSES,
  };
}

/**
 * What almost every weapon in the world inflicts, shared so the common case
 * costs nothing: one frozen empty list rather than one per body per frame.
 */
const NO_WEAPON_STATUSES: readonly WeaponStatus[] = [];

/**
 * What a body with nothing worn resists, shared on exactly those terms: one
 * empty block rather than one per body per frame.
 */
export const NO_RESISTANCES: WeaponResistances = {};

/** Floors of perception, up or down. Whole floors — half a look is not a thing. */
const levelSlack = v.pipe(v.number(), v.integer(), v.minValue(0));

const battlerSchema = v.object({
  // Both required, unlike the optionals below: a body with no masteries and no
  // weapon has no numbers at all, and there is nothing sensible to invent for
  // it. Anything on disk from before this existed fails here and reads as "not
  // a battler", which is the correct answer — those tiles have to be re-authored.
  masteries: masteriesSchema,
  naturalWeapon: weaponSchema,
  // `range` used to sit here, and it is gone rather than tolerated: a body's
  // reach is now its weapon's, and an authored number left on the tile would be
  // a second answer that silently loses. Anything on disk still carrying one
  // parses fine and the field is dropped — see `../lib/interactions`, which no
  // longer writes it back.
  sight: v.optional(
    v.object({ up: levelSlack, down: levelSlack }),
    // A getter, so two tiles never share one mutable block.
    () => ({ up: 0, down: 0 }),
  ),
  // Optional on the terms `range` and `sight` are — every creature in `data/`
  // predates it — and never rejected once present, since {@link kitSchema}
  // falls back to nothing rather than failing the block around it.
  kit: v.optional(kitSchema, () => []),
});

const battlerCache = new WeakMap<TileDef, BattlerDef | null>();

/**
 * Parsed battler stats for a tile def, or null when it has none.
 *
 * **Gated on the kind.** A tile whose kind is not `battler` has no stats however
 * much of a block is sitting in the file — see {@link TileKind} for why the
 * stored field wins over the block rather than the other way round. Without the
 * gate, the select in the editor and the data on disk could disagree about what
 * a tile is, and the disagreement would only surface as a fight nobody expected.
 *
 * Memoised on def identity, like every other resolver here: this is asked once
 * per body per attack *and* once per body per frame by the renderer drawing
 * health bars, and re-validating a block at that rate would be the most
 * expensive thing in either loop.
 */
export function resolveBattler(def: TileDef): BattlerDef | null {
  const cached = battlerCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.kind === "battler" ? def.interactions?.battler : undefined;
  const parsed = raw == null ? null : v.safeParse(battlerSchema, raw);
  const battler = parsed?.success ? (parsed.output as BattlerDef) : null;
  battlerCache.set(def, battler);
  return battler;
}

/** Whether this tile has hit points at all. */
export function isBattler(def: TileDef): boolean {
  return resolveBattler(def) !== null;
}
