import * as v from "valibot";
import { type Element, ELEMENTS } from "./element";
import {
  type ArcaneStoneItem,
  DEFAULT_WEAPON,
  MAX_PERCENT_STAT,
  MELEE_REACH,
  type ProjectileDef,
  type Reach,
  stoneSchema,
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
  requirementShortfall,
  spellElements,
  type WeaponMastery,
} from "./mastery";
import { type AnchoredSprite, defaultBase, type TileDef } from "./types";

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
   * Hit points this body has at Toughness zero, before the mastery adds any.
   *
   * **The one part of a body's health an author still types, and Toughness
   * cannot reach it.** Everything else about a fight now falls out of masteries
   * and a weapon, which is what stops a rat being a smaller snake — but it also
   * left the *size* of a body with nowhere to be stated. A boss is not a wolf
   * that has practised more; it is a bigger thing, and a bigger thing takes more
   * killing whether or not it has ever trained.
   *
   * Added to {@link maxHpFrom}'s curve rather than multiplying it, deliberately:
   * a multiplier would make the same hundred points of Toughness worth ten times
   * as much on the boss as on the player, and the mastery would stop meaning one
   * thing. As a flat term it says what it looks like — this body starts that
   * much further up — and every point of Toughness anybody trains is still worth
   * the same to them.
   *
   * Required, unlike the optionals below, and that is what the field is for.
   * Left optional it would default to a number nobody chose, and every creature
   * in the world would keep the base it had before anybody thought about it. A
   * block on disk without one fails the schema and reads as "not a battler" —
   * see {@link resolveBattler} — which is the same bargain `masteries` and
   * `naturalWeapon` already make.
   */
  baseHp: number;
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
  /**
   * What this body is *made of*, for anything elemental thrown at it.
   *
   * **Authored, and never derived from the masteries.** What a body has
   * practised says what it can *cast*; what it is says what magic does to it,
   * and those are two different facts about one creature. A rat that had somehow
   * learnt some Fire would otherwise become a fire creature by accident, and a
   * player would become weak to water by training the element they were best at
   * — a progression that punishes you for progressing.
   *
   * A cave troll is fire because a cave troll is fire. A rat is nothing, which
   * is the default and the overwhelmingly common answer: absent means neutral,
   * and a neutral body neither gains nor loses on `../lib/element`'s wheel.
   *
   * **This is only half of what a body counts as.** The other half is worn — a
   * tunic of flames makes its wearer fire for as long as it is on — and the two
   * are unioned where the question is actually asked, in `../game/equipment`'s
   * {@link bodyElements}. Nothing reads this field alone.
   */
  elements?: Element[];
  /**
   * Statuses this body simply cannot take, by id.
   *
   * **The only kind of resistance that is not a number.** Everything else about
   * taking damage is arithmetic — armour subtracts, an element multiplies — and
   * arithmetic is right for things that hurt *more or less*. A condition is not
   * one of those: a wolf is not ninety percent less made ill by carrion, it eats
   * carrion and is fine, and the honest way to say that is a list rather than a
   * hundred percent resistance that a stacked source could still get past.
   *
   * **Checked where a status is applied and nowhere else** — see
   * `../game/GameSession`'s `grantStatus`, which is the one gate every source
   * goes through. So an immunity holds against the food, the blade dipped in it,
   * the hearth and the spell alike, without any of them knowing about it. That
   * is the whole reason it lives on the body rather than beside each source.
   *
   * Optional and absent means "takes everything", which is every body in the
   * world but the ones an author has said otherwise about. An id the status
   * catalogue no longer holds is an immunity to nothing, on the terms a kit
   * naming a deleted tile is: content moved on, and nothing breaks.
   */
  immuneTo?: string[];
  /**
   * The tile this body leaves where it falls, or absent for one that leaves
   * nothing.
   *
   * **What makes a skull authored rather than a rule about players.** It was a
   * rule: the engine knew one tile id and one body tile, and every other death
   * in the world left only what the body had been carrying. That is the right
   * default — a world where every rat leaves a keepsake is knee-deep in rats'
   * skulls by the evening — but it is a *default*, and a boss worth killing
   * once is exactly the case that wants to say otherwise.
   *
   * On the battler block because only a battler can die. A tile with no hit
   * points never reaches the death that would read this.
   *
   * **The tile is chosen; what it says is not.** What lands is engraved with
   * whoever this body was and described by what killed them — see
   * `../game/blame` and `./engraving` — so an author picks the art and the
   * world fills in the rest. A tile whose name has no `%s` in it simply ignores
   * the engraving, which is what lets `Troll skull` be a perfectly good thing
   * for a troll to leave.
   *
   * A tile id rather than a tile, on a kit's terms: this module resolves no
   * tiles. One the catalogue no longer holds leaves nothing, which is how a
   * renamed piece of content should read.
   */
  remains?: string;
  /**
   * Spells this body has of its own, with nothing in its hands.
   *
   * **{@link naturalWeapon}'s opposite number, and the same bargain.** A body
   * that could only cast what it was carrying meant a caster had to be given a
   * stone, a hand to hold it in and a kit roll that produced it — so a troll
   * that breathes fire was three pieces of content and a chance of arming the
   * player who killed it. What a body can *do* is a fact about the body, on
   * exactly the grounds a bite is.
   *
   * They are {@link ArcaneStoneItem}s and not a second vocabulary. Everything a
   * stone already knows how to say — a bolt, a conjure, a cooldown, a cast
   * time, what it asks of whoever casts it, how far it reaches, what it leaves
   * behind — is what a natural spell needs to say, and a parallel block would
   * be the same fields drifting apart. `../game/casting` decides one the same
   * way it decides the other; only where the cooldown is kept differs.
   *
   * **A name each, because a stone has none.** A carried stone is a tile and
   * the tile is what a death by it has to say; a natural spell has no tile, so
   * it carries its name for the same three readers a natural weapon's is for —
   * a skull's engraving, the button's label, and the brain line that names
   * which spell to cast. Names are how a brain names one, so renaming a spell
   * is renaming what a `cast` action points at, exactly as renaming a tile id
   * is.
   *
   * Optional and absent means "casts nothing", which is every body in the world
   * but the ones an author has said otherwise about.
   */
  spells?: NaturalSpell[];
};

/**
 * A spell a body has rather than holds.
 *
 * A stone plus the two things a carried one gets from its tile: what it is
 * called, and what to draw on the button that presses it.
 */
export type NaturalSpell = ArcaneStoneItem & {
  /**
   * What it is called. Required, unlike a natural weapon's name, because this
   * one is an identifier as well as a label: a brain's `cast` action names the
   * spell it wants, and an unnamed spell is one nothing can point at.
   */
  name: string;
  /**
   * The picture on the button that casts it, or absent for a spell nobody has
   * drawn yet.
   *
   * A bare sprite rather than a tile id, on `../lib/status`'s {@link
   * StatusDef.icon} terms and for its reason: there is no tile to borrow one
   * from, and a spell that only a creature ever casts has no button at all. A
   * blank disc is a better answer than refusing to load the body.
   */
  icon?: AnchoredSprite;
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
   * **The whole of {@link hitChance} and nothing else.** It no longer says how
   * much a connecting blow is worth — that is {@link variance} — and it no
   * longer says how hard the blow is to dodge, which is {@link flee} on both
   * sides of `../game/combat`'s `dodgeChance`. What is left is one question
   * about the swinger and the thing in their hand: did the swing go where it was
   * aimed.
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
   * How much faster or slower than {@link spd} alone this body swings.
   *
   * Two things multiply into it, and they pull opposite ways: **Agility speeds
   * you up, and falling short of what the weapon asks slows you down** — see
   * {@link hasteFrom} and {@link weaponHandling}. Both are facts about this body
   * swinging this weapon, which is exactly the pair `fightingStats` is given.
   *
   * **A multiplier on the rate rather than a term in {@link spd}, and that is
   * load-bearing in both directions.** `spd` is a position on a geometric curve
   * running 100:1 from end to end, so a body three times as fast as a maxed
   * weapon has no `spd` to say so with — and, the other way, docking `spd` by a
   * quarter is not a quarter off the rate but close to three quarters off it.
   * Handling is quoted to the player as a share of their accuracy and swing
   * rate, so it has to be applied where a share of the rate is what it means.
   *
   * Applied where the interval is worked out — `../game/combat`'s
   * `swingIntervalMs` — so the result is still a whole number of ticks.
   *
   * One for a body with no Agility holding something it has earned, which is
   * every authored creature that has not been given any.
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
   * 0–100. Evasion, and the same number read the other way round when this body
   * is the one swinging.
   *
   * Contested against the *other* body's `flee` on a logistic curve — see
   * `../game/combat`'s `dodgeChance` and `reflex`. Getting out of the way and
   * staying with something that is getting out of the way are one faculty, so
   * Agility buys both at once and a dodge is a race between two bodies with
   * nothing in their hands bearing on it.
   *
   * Level pegging favours the swinger by `REFLEX_EDGE`, because a dodge is the
   * exception; neither end ever reaches certainty.
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
 * What a body's {@link BattlerDef.baseHp} starts at when the Battler box is
 * first ticked.
 *
 * A default for the editor and nothing more — every battler authors its own,
 * and nothing derives hit points from this constant. Eight, which is what every
 * body's base used to be when there was only one of them, so a creature
 * migrated onto the field and left alone fights exactly as it did.
 */
export const DEFAULT_BASE_HP = 8;

/**
 * The narrowest and widest a body's base may be.
 *
 * One rather than zero, because a body whose base is nothing is a body that dies
 * to the first blow before Toughness has bought it anything, and that reads as a
 * mis-typed field rather than as a design. The ceiling is well above the
 * hundreds a boss wants and exists only so a stray keystroke in the editor
 * cannot author something the health bar has to render.
 */
export const MIN_BASE_HP = 1;
export const MAX_BASE_HP = 100000;

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
 * Non-zero for the same reason {@link DEFAULT_BASE_HP} is: dodging is contested against
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
 * Hit points a body of this size with this much Toughness starts at.
 *
 * The base is passed in rather than read off a constant, because how big a body
 * is and how much it has trained are two different facts about it — see
 * {@link BattlerDef.baseHp}. What Toughness is worth does not depend on which
 * body is training it, which is why the base is a term and not a factor.
 *
 * Rounded to a whole hit point, which is the only unit health is ever counted
 * in — a fractional maximum would put a health bar at 13.25 and a damage number
 * against it that never quite empties it. The base is added after the rounding
 * because it is already whole.
 */
export function maxHpFrom(baseHp: number, toughness: number): number {
  return (
    baseHp +
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
 * How well a body with this much Agility gets out of the way — and, read the
 * other way round, how well it stays with something else that is.
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
 * What each point of requirement you are short costs you, as a share of your
 * accuracy and your swing rate.
 *
 * **A twentieth per point, counted in points rather than in proportion**, so
 * "two points short" means the same handicap wherever on the ladder a player is
 * standing: ten percent off both, whether the weapon asks five or fifty.
 *
 * ## It was a share of what you brought, and a share cannot keep both promises
 *
 * Two things are asked of the gate, and they pull against each other:
 *
 * - **Two points short of the next rung, that rung is already worth carrying.**
 *   Reaching is the whole point of a ladder; a requirement you have to stand and
 *   wait behind is a wall.
 * - **Two rungs up is still a mistake.** Otherwise there is no ladder at all — a
 *   new player walks to the best weapon in the world and swings it.
 *
 * Write `h` for handling and `r` for how much better each rung is than the one
 * below. Both promises are about one body at one moment, so the weapons' own
 * numbers cancel and what is left is `r·h(two short)² > 1 > r²·h(two rungs up)²`
 * — a window for `r` at all only when `h(two rungs up) < h(two short)²`.
 *
 * Read off the *share* of what a weapon asks, those two are much closer together
 * than they look, because the ladder's rungs get further apart as it climbs: two
 * points short of Sharp 10 is a share of 0.80, and the whole seven points from
 * Sharp 8 to Sharp 15 is still 0.53. A curve steep enough to make 0.80 hurt is
 * far too steep at 0.53. Cubing the share and charging half of it gave
 * `h = 0.76` and `0.58`, and `0.58 > 0.57`: **the window was empty, whatever any
 * weapon was authored at.** No damage number could buy both promises.
 *
 * Counting the points decouples them. At a twentieth apiece, two short is 0.90
 * and seven short is 0.65, so `r` may be anything from 1.24 to 1.54 — and the
 * authored ladder needs only a modest lift to sit inside that, where a share
 * would have demanded the weapons outrun every creature in the world.
 *
 * ## Softer where it was asked to be, harder where it had to be
 *
 * Against the cube at half bite, on the sword ladder:
 *
 * ```
 *   short of it   2 of 10   2 of 15   2 of 33   7 of 15   10 of 15
 *   cube, half      0.76      0.83      0.92      0.58       0.51
 *   this            0.90      0.90      0.90      0.65       0.50
 * ```
 *
 * Every "a couple of points short" case is gentler, which is what was asked for.
 * Everything a long way out of reach is as hard as it was or harder, which is
 * what pays for it.
 */
export const HANDLING_PER_POINT_SHORT = 0.05;

/**
 * The least a weapon can handle at, however little its wielder brings.
 *
 * **Not zero, for the reason it never was.** A weapon nobody can use at all is a
 * weapon nobody can learn on, and getting better with a thing by swinging it is
 * how every mastery in this game moves. At 0.15 a body seventeen points out of
 * its depth still swings — slowly, wildly, and for the blade's full damage.
 */
export const MIN_HANDLING = 0.15;

/**
 * How well this body handles a weapon, as a fraction of 1 — its accuracy and its
 * swing rate, and never its damage.
 *
 * One when every requirement is met, and {@link HANDLING_PER_POINT_SHORT} off
 * for each point missing, down to {@link MIN_HANDLING}.
 *
 * @param shortfall pooled points of requirement missing, from `./mastery`'s
 *   {@link requirementShortfall}.
 */
export function weaponHandling(shortfall: number): number {
  return Math.max(MIN_HANDLING, 1 - HANDLING_PER_POINT_SHORT * Math.max(0, shortfall));
}

/**
 * What being good with a weapon adds, over and above being *allowed* to use it.
 *
 * **The half of mastery that requirements deliberately do not cover.** A Sharp
 * 100 hero holding a requirement-1 dagger has met that requirement a hundred
 * times over and gets nothing for it from {@link weaponHandling}, which caps at
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
 * through {@link weaponHandling}, and being good with it already pushes that
 * accuracy up — so charging for either a second time here would be charging
 * twice for the same fact.
 *
 * Held inside the band nothing in a fight escapes: a weapon far beyond you still
 * lands one swing in twenty, so it is poor rather than inert and can still teach
 * you; and a master still whiffs one in twenty, because nothing is ever certain.
 *
 * **Accuracy above 100 buys nothing, and that is now true rather than nearly
 * true.** It used to carry on paying past the ceiling because a defender's
 * evasion was contested against it; the contest is Agility against Agility now,
 * so the surplus stops here. What mastery keeps buying past that point is
 * damage, and a body that wants to catch nimble things trains Agility for it —
 * which is the point of moving the contest, not a side effect of it.
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
  baseHp: DEFAULT_BASE_HP,
  masteries: { fist: 8, toughness: 8, agility: 8 },
  naturalWeapon: { ...DEFAULT_WEAPON, mastery: "fist", reach: { ...MELEE_REACH } },
  sight: { up: 0, down: 0 },
  // Nothing, because what a body carries is the one part of it an author has to
  // decide: a default sword would arm every creature anybody ticks the Battler
  // box on, and arming things is the whole point of the field.
  kit: [],
};

/**
 * What this body turns aside on its own, wearing and holding nothing.
 *
 * **Toughness's share of defence, and the one part of it that is not worn.**
 * `../game/equipment`'s `wornDefence` sums the three squares — hand, off hand,
 * chest — and `effectiveBattler` *assigns* that total rather than adding to it,
 * which is what stops the main hand being counted twice. This is the term that
 * survives that assignment, so it is named here and added by both callers rather
 * than spelled out in either.
 */
export function bodyDefence(battler: BattlerDef): number {
  return defFrom(masteryLevel(battler.masteries, "toughness"));
}

/**
 * A body and what it is swinging, resolved into numbers.
 *
 * The weapon is passed in rather than read off the body because *which* weapon
 * is not this module's question — a held sword replaces the natural one, and
 * knowing that is `../game/equipment`'s job. This function knows only how a
 * profile plus a set of masteries becomes a fight.
 *
 * Both halves of "how good are you with this" are applied here and nowhere else,
 * which is what keeps it a single question with a single answer. They pull on
 * different numbers: skill with the mastery raises `damage` and `accuracy`, and
 * falling short of the requirements lowers `accuracy` and `haste`. `variance` is
 * moved by neither, because it is the width of the damage band rather than a
 * measure of the wielder.
 *
 * Hit points and flee are untouched by the weapon, which is the other half of
 * the split: what a body *is* cannot be picked up or put down.
 */
export function fightingStats(
  battler: BattlerDef,
  weapon: WeaponItem,
): FightingStats {
  // How much of what the weapon asks this body brings, and how well it therefore
  // handles right now. Falling short makes a weapon clumsier and slower and
  // leaves its damage alone — see {@link MIN_HANDLING}.
  const handling = weaponHandling(
    requirementShortfall(battler.masteries, weapon.requirements),
  );

  // The mastery the weapon itself answers to, read at its absolute level. This
  // is the "you are simply good with blades" term, and it is deliberately not a
  // ratio against the requirement — see {@link MASTERY_DAMAGE_BONUS}.
  const skill = masteryLevel(battler.masteries, weapon.mastery) / MAX_MASTERY;

  // **Damage is not touched by handling, which is the whole of the fairness
  // rule.** A weapon you are short of is the harder-hitting weapon — that is why
  // you picked it up — and scaling this by the shortfall made it hit softer than
  // the one you had already outgrown, so there was never a moment worth reaching
  // for the next rung. What being short of it costs you is `accuracy` and
  // `haste` below.
  //
  // **A weapon authored at no damage does none, however skilled its wielder.**
  // The flat term is what skill adds *to a weapon*, and a shield is not one —
  // it is a `def` with a handle, and `../game/equipment` puts it in the main
  // hand precisely so that taking one up costs you your swing. Without this,
  // skill manufactured damage out of a thing whose author wrote zero, and a
  // shielded body chipped away at whatever it was hiding from.
  const damage =
    weapon.damage <= 0
      ? 0
      : weapon.damage * (1 + skill * MASTERY_DAMAGE_BONUS) +
        skill * DAMAGE_AT_MAX_MASTERY;
  // **Handling gates the skill bonus too, flat part included.** It is the
  // outermost factor rather than something applied to the weapon's own accuracy
  // and then added to, and that placement is the whole rule: what mastery buys
  // you is *more out of this weapon*, so being good with blades cannot cancel
  // out being short of this one. Left ungated, the flat term did not depend on
  // the weapon at all, and the gate had a hole cut in it exactly where the
  // strongest players stand.
  const accuracy =
    handling *
    (weapon.accuracy * (1 + skill * MASTERY_ACCURACY_BONUS) +
      skill * ACCURACY_AT_MAX_MASTERY);

  return {
    maxHp: maxHpFrom(
      battler.baseHp,
      masteryLevel(battler.masteries, "toughness"),
    ),
    flee: fleeFrom(masteryLevel(battler.masteries, "agility")),
    damage: Math.round(damage),
    // The weapon's own plus the body's, which is the first time defence has had
    // a source that is not a held item — see {@link defFrom}.
    def: weapon.def + bodyDefence(battler),
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
    // Agility's gift and the shortfall's cost, in the one field that is a
    // multiplier on the rate. How quick you are is yours — a heavy axe in quick
    // hands is a hastened heavy axe rather than a dagger — and how short of the
    // axe you are is yours too. Mastery's reward for speed is Agility's alone to
    // give: paying it twice would make a trained blade both harder-hitting and
    // faster for the same points.
    haste: hasteFrom(masteryLevel(battler.masteries, "agility")) * handling,
    // The weapon's own, untouched. What being short of it costs you is a share
    // of the *rate*, and that is `haste` above — docking `spd` instead would
    // charge a geometric curve for a proportional shortfall.
    spd: weapon.spd,
    // Both off the weapon, not the body — the one place a bow differs from a
    // fist in kind rather than in degree. Untouched by handling above: a novice
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

/**
 * How good this body is at the spell it is holding, as a fraction of 1.
 *
 * **The caster's answer to `fightingStats`' `skill`, and it reads more than one
 * mastery because a spell is more than one thing.** A weapon answers to exactly
 * one mastery, so how good you are with it is one number divided by the top of
 * the scale. A spell answers to two facts that the codebase already keeps
 * apart — see `./element`: **Arcane says how good you are at magic at all, and
 * an element says what you point it at** — so reading only the first would make
 * a Fire 1 arcanist throw the same fire as a Fire 100 one, and reading only the
 * second would make somebody who has never cast anything a specialist.
 *
 * So it is the **mean of Arcane and each element the spell is made of**, and the
 * mean rather than a sum for two reasons. It keeps the answer on the 0–1 scale
 * {@link MASTERY_DAMAGE_BONUS} and {@link DAMAGE_AT_MAX_MASTERY} are written
 * against, so a spell is worth to a master exactly what a weapon is. And it
 * makes a two-element spell *harder* rather than merely more expensive: a stone
 * asking Fire and Water is thrown at the average of three numbers, so somebody
 * who has trained only one half of it gets a third of the spell however good
 * their Arcane is.
 *
 * **Which elements a spell is made of is read off its requirements**, which is
 * the only place a spell's element is ever written down — see `./mastery`'s
 * {@link spellElements}. An elementless spell is Arcane alone, which is the
 * right answer for a stone of light: magic that is not made of anything is
 * thrown as well as you throw magic.
 *
 * **Requirements are not consulted as a ratio here, unlike a weapon's**, and the
 * absence is deliberate rather than an oversight. `weaponHandling` exists
 * because a weapon you have not earned still swings; a stone you have not earned
 * does not fire at all — `./mastery`'s `meetsRequirements` refuses it — so
 * at every call site this has, the share is one by construction. Writing the
 * term anyway would be a factor that can never be anything but one, sitting in
 * the formula inviting somebody to believe it does something.
 */
export function castingSkill(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  const elements = spellElements(requirements);
  let total = masteryLevel(masteries, "arcane");
  for (const element of elements) total += masteryLevel(masteries, element);
  return total / ((1 + elements.length) * MAX_MASTERY);
}

/**
 * What one press of this stone is worth in the caster's hands, before the
 * variance roll and before whoever it lands on has had a say.
 *
 * **The same two terms a weapon's damage gets, against the same two constants**,
 * which is the whole of "a spell scales like a weapon": a share of the stone's
 * own worth, so a better stone rewards mastery more in absolute terms and the
 * tiers stay ordered; and a flat amount, so mastery is worth training even with
 * something small in your hand. What differs is only *which* masteries are read,
 * and that is {@link castingSkill}'s business.
 *
 * **Worked in magnitude and given its sign back**, because a mend is a harm with
 * a minus in front of it — see `./item`'s {@link StoneEffect} — and the flat
 * term has to make a mend *deeper* rather than shallower. Signing it any later
 * would make mastery quietly cancel out a stone of life.
 *
 * Unrounded, so the variance roll happens on the real figure and the rounding
 * happens once at the end — the same order `../game/combat`'s
 * {@link potentialDamageFrom} puts a swing through, and for the same reason: a
 * blow is a whole number of hit points and rounding twice is a blow nobody can
 * work out.
 */
export function spellPower(
  damage: number,
  requirements: Masteries | undefined,
  masteries: Masteries,
): number {
  if (damage === 0) return 0;
  const skill = castingSkill(masteries, requirements);
  const magnitude =
    Math.abs(damage) * (1 + skill * MASTERY_DAMAGE_BONUS) +
    skill * DAMAGE_AT_MAX_MASTERY;
  return damage < 0 ? -magnitude : magnitude;
}

/**
 * Longest a natural spell's name may be.
 *
 * A bound rather than a balance figure, on {@link MAX_BASE_HP}'s terms: a name
 * is what a button is labelled with, what a skull is engraved with and what a
 * brain line points at, and a paragraph in any of those three is a mistake
 * rather than a style. It is enforced on the wire too — see `../net/protocol` —
 * because a `cast` message names a spell by it.
 */
export const MAX_SPELL_NAME_LENGTH = 48;

/**
 * What the first spell somebody adds is called, until they name it.
 *
 * A placeholder rather than a meaning: the name is required — a spell has to be
 * called *something* to be drawn on a button or engraved on a skull — and a box
 * that opened empty would be one the schema refuses the moment it is saved.
 */
export const DEFAULT_SPELL_NAME = "Spell";

/** Floors of perception, up or down. Whole floors — half a look is not a thing. */
const levelSlack = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * The picture on a natural spell's button.
 *
 * Restated here rather than imported from the tile schema or the status one, on
 * exactly the grounds `../lib/status`'s own copy is: the three are validated at
 * different boundaries, and a spell must not start depending on what a tile
 * happens to allow. The base is filled in on the way out, so everything
 * downstream of a parse has a whole {@link AnchoredSprite} rather than the same
 * `??` at each place that draws one.
 */
const iconSchema = v.pipe(
  v.object({
    tilesetId: v.string(),
    rect: v.object({
      x: v.pipe(v.number(), v.integer(), v.minValue(0)),
      y: v.pipe(v.number(), v.integer(), v.minValue(0)),
      w: v.pipe(v.number(), v.integer(), v.minValue(1)),
      h: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    base: v.optional(
      v.object({
        x: v.pipe(v.number(), v.integer(), v.minValue(0)),
        y: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
  }),
  v.transform(
    (raw): AnchoredSprite => ({
      ...raw,
      base: raw.base ?? defaultBase(raw.rect),
    }),
  ),
);

const battlerSchema = v.object({
  // All three required, unlike the optionals below: a body with no masteries and
  // no weapon has no numbers at all, and one with no base has no size, and there
  // is nothing sensible to invent for either. Anything on disk from before this
  // existed fails here and reads as "not a battler", which is the correct
  // answer — those tiles have to be re-authored.
  //
  // Whole hit points, because that is the only unit health is counted in — see
  // {@link maxHpFrom}, which rounds the mastery's share for the same reason.
  baseHp: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(MIN_BASE_HP),
    v.maxValue(MAX_BASE_HP),
  ),
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
  // Optional on the terms `sight` and `kit` are — every creature in `data/`
  // predates it — and absent reads as neutral, which is what almost every body
  // in the world is.
  elements: v.optional(v.array(v.picklist(ELEMENTS))),
  // Ids rather than a picklist, because the status catalogue is authored data
  // this module has never seen — the same reason a kit names a tile id. One the
  // catalogue no longer holds is an immunity to nothing, which costs nothing.
  immuneTo: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  // A tile id this module never resolves, on `immuneTo`'s own terms. Absent is
  // every body in the world but the handful worth remembering.
  remains: v.optional(v.pipe(v.string(), v.minLength(1))),
  // The stone schema with a name bolted on, rather than a schema of its own: a
  // natural spell *is* a stone, and two shapes that had to be kept saying the
  // same thing is the arrangement `StoneEffect` was folded together to avoid.
  //
  // Optional and defaulted to nothing, on `kit`'s terms — every creature in
  // `data/` predates it. A spell that does not validate takes the whole battler
  // block with it, which is this module's standing bargain: a half-parsed body
  // would be a creature whose author cannot see what is wrong with it.
  spells: v.optional(
    v.array(
      v.object({
        ...stoneSchema.entries,
        // Required where a weapon's name is optional, because a brain names the
        // spell it casts: an unnamed one is a spell nothing can point at.
        name: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(MAX_SPELL_NAME_LENGTH),
        ),
        icon: v.optional(iconSchema),
      }),
    ),
    () => [],
  ),
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
