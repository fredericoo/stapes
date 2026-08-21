import * as v from "valibot";
import {
  DEFAULT_WEAPON,
  MAX_PERCENT_STAT,
  MELEE_REACH,
  type ProjectileDef,
  type Reach,
  weaponSchema,
  type WeaponItem,
} from "./item";
import { type Kit, kitSchema } from "./kit";
import {
  type Masteries,
  masteriesSchema,
  masteryLevel,
  masteryRatio,
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
  /** Flat reduction on every blow that lands. */
  def: number;
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
};

/**
 * Hit points a body has before Toughness adds any.
 *
 * Not zero, because a mastery of zero is a novice rather than a corpse: a fresh
 * body with nothing trained still has to survive long enough to train it.
 */
export const BASE_HP = 8;

/** Hit points each point of Toughness is worth. */
export const HP_PER_TOUGHNESS = 1;

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

/** Hit points a body with this much Toughness starts at. */
export function maxHpFrom(toughness: number): number {
  return BASE_HP + Math.round(HP_PER_TOUGHNESS * toughness);
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
 * What the mastery ratio does to the three things a weapon is worth.
 *
 * **Accuracy carries the penalty, and speed and damage degrade gently.** A
 * novice swinging a double axe hits almost nothing and hits hard when they
 * connect, which is the character the whole system is built to produce — the
 * alternative, spreading the penalty evenly, gives you a weapon that is simply
 * worse at everything and reads as a number going down rather than as a person
 * out of their depth.
 *
 * The floors are why an unmastered weapon is still worth picking up: at `q = 0`
 * you keep 55% of its speed and 70% of its damage. What you do not keep is the
 * ability to land it.
 */
export const SPEED_AT_ZERO_RATIO = 0.55;
export const SPEED_PER_RATIO = 0.45;
export const DAMAGE_AT_ZERO_RATIO = 0.7;
export const DAMAGE_PER_RATIO = 0.3;

/**
 * The chance a swing connects at all.
 *
 * Two independent failures, multiplied: **the weapon has to find its target, and
 * you have to be able to control it.**
 *
 * - `accuracy / 100` is the weapon's own. A clumsy weapon whiffs in expert hands,
 *   which is the thing it was missing — before this, mastery was the only input
 *   and a beautifully balanced blade you could not control whiffed exactly as
 *   often as a lump of iron you could not control.
 * - The ratio term is you. Squared, so the penalty bites hardest low down.
 *
 * **The ratio is capped at 1 where speed and damage are not.** Above `q = 1`
 * there is no such thing as more than landing, so the surplus a 1.25 ratio buys
 * goes into the other two rather than being spent on a probability that cannot
 * exceed certainty.
 *
 * Clamped by `../game/combat`'s shared band, which is where the old dedicated
 * floor on this went: a weapon far beyond you still lands one swing in twenty,
 * so it is poor rather than inert and can still teach you. One rule in one place
 * rather than a second constant here saying the same thing.
 */
export function hitChanceFrom(ratio: number, accuracy: number): number {
  const control = Math.min(1, ratio * ratio);
  const precision = Math.max(
    0,
    Math.min(1, accuracy / MAX_PERCENT_STAT),
  );
  return clampChance(precision * control);
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
  const ratio = masteryRatio(battler.masteries, weapon.requirements);

  return {
    maxHp: maxHpFrom(masteryLevel(battler.masteries, "toughness")),
    flee: fleeFrom(masteryLevel(battler.masteries, "agility")),
    hitChance: hitChanceFrom(ratio, weapon.accuracy),
    damage: Math.round(
      weapon.damage * (DAMAGE_AT_ZERO_RATIO + DAMAGE_PER_RATIO * ratio),
    ),
    def: weapon.def,
    accuracy: weapon.accuracy,
    variance: weapon.variance,
    // Clamped, because a 1.25 ratio can push an already-fast weapon past the top
    // of the scale, and `attackIntervalMs` reads this as a position on a curve
    // rather than as a number that may run off the end of it.
    spd: Math.min(
      MAX_PERCENT_STAT,
      Math.round(weapon.spd * (SPEED_AT_ZERO_RATIO + SPEED_PER_RATIO * ratio)),
    ),
    // Both off the weapon, not off the body — the one place a bow differs from a
    // fist in kind rather than in degree. Untouched by the mastery ratio above:
    // a novice archer is worse at hitting what they aim at, and the arrow still
    // flies as far as the bow throws it.
    reach: weapon.reach,
    projectile: weapon.projectile ?? null,
    sight: battler.sight,
  };
}

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
