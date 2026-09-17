import type { BattlerDef } from "../lib/battler";
import { MELEE_REACH, type Reach } from "../lib/item";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { damageBand, swingIntervalMs } from "./combat";
import {
  type Equipment,
  effectiveBattler,
  handToSwing,
} from "./equipment";
import { walkDurationMsFor } from "./movement";
import {
  type StatusInstance,
  walkSpeedPercentFrom,
  withStatusModifiers,
} from "./statuses";

/**
 * What a body comes to, in the numbers a player can act on.
 *
 * ## Why this is a projection and not `FightingStats`
 *
 * `FightingStats` is what a blow is resolved against, and half of it is not a
 * reading: `accuracy` is a position in a contest, `variance` is the width of a
 * band, `haste` is a multiplier on a curve. None of those answer a question
 * anybody asks before a fight. What a player wants to know is how hard they
 * hit, how often, how likely it is to land, how much they turn aside, and how
 * fast they get out of the way — so this is that, worked out through the same
 * functions the fight uses and never restated.
 *
 * ## Every field is a primitive, on purpose
 *
 * The block is pushed to the chrome on the same channel the hit points are and
 * is diffed there — see `../render/GameRenderer`'s `pushVitals`. A nested object
 * would be a fresh identity every tick and would re-render the panel thirty
 * times a second, so the wording rules that belong to somewhere else are
 * resolved to strings *here* rather than carried as the shapes they came from.
 */
export type Attributes = {
  /**
   * The narrowest and widest one blow is worth, before the defender's guard.
   *
   * Two numbers rather than `FightingStats.damage` and a variance, because a
   * variance is not a reading — see `./combat`'s `damageBand`, which is where
   * that argument lives and where both ends come from. Flattened to a pair of
   * primitives here rather than carried as the band it came back as, for the
   * reason every other field of this block is one.
   */
  minDamage: number;
  maxDamage: number;
  /** Milliseconds between blows, Agility and a weapon you are short of both counted. */
  swingMs: number;
  /** 0–1. How often a swing connects with anything at all. */
  hitChance: number;
  /** Flat reduction on every blow that lands. */
  def: number;
  /** Evasion — one side of a contest rather than a probability. @see `./combat`'s `dodgeChance` */
  flee: number;
  /**
   * How far a blow carries: "Melee", "8c", or "2–8c" for something with a floor.
   *
   * **Shorter than `./itemCard`'s `reachLine`, which says "2–8 cells, fired" for
   * a bow.** The panel's cell is about fourteen characters wide, and whether a
   * blow puts an arrow in the air is a thing you watch happen and a thing the
   * weapon's own card states. An arm's length is still named rather than
   * measured, on `reachLine`'s argument: "1.5 cells" is a figure nobody can
   * picture and every melee weapon in the game shares it.
   *
   * **The floor is not what gets dropped to make it fit.** It is the one part of
   * a reach that says what the weapon *cannot* do, and a bow reading "8c" when
   * it is dead inside two cells has told the reader nothing about the fight they
   * are about to lose — the same argument `reachLine` makes at length. A body
   * with a floor is also never "Melee", however short the rest of its reach.
   * @see `../lib/item`'s `Reach.min`
   */
  reach: string;
  /**
   * Cells a second, statuses counted.
   *
   * A rate rather than the milliseconds a step takes, unlike {@link swingMs}. A
   * step is a tenth of a swing's length — the pace a player walks at is 150ms —
   * and a duration rounded to the tenth of a second everything else here is
   * quoted in would read "0.2s" for every body in the game. The reciprocal has
   * room to move.
   */
  walkPace: number;
};

/**
 * Which hand the panel reports, for a body that could swing either.
 *
 * **Fixed rather than the hand whose turn it is.** The rotation is state of a
 * fight — `GameSession` advances it where a swing is actually spent, and it is
 * never broadcast — so a reading taken from it would flip between two sets of
 * numbers every blow on one client and sit still on the other. A body holding
 * two different weapons therefore has a second blow this does not describe,
 * which is the honest cost of a panel that holds still; the card on each weapon
 * says what that one is worth. @see `./equipment`'s `handToSwing`
 */
const REPORTED_HAND = "weapon";

/**
 * What this body fights and walks at, all in.
 *
 * **The one place the panel's numbers are worked out**, called by the
 * simulation and by the browser alike, which is what stops `/play` and a
 * connected world from quoting two different figures for one body. It is built
 * out of `effectiveBattler` and `withStatusModifiers` rather than beside them,
 * so the only thing it can disagree with a real blow about is which hand — see
 * {@link REPORTED_HAND}.
 *
 * `hp` is what the bearer has right now, for the status formulas that read it;
 * null means "ask the body", which is what a fresh actor whose hit points have
 * never been filled in answers.
 */
export function attributesOf({
  body,
  bodyDef,
  equipment,
  tilesById,
  statuses,
  statusDefs,
  hp,
}: {
  /** The battler block with whatever masteries this body has actually earned. */
  body: BattlerDef;
  /** The tile the body is, for the pace it is authored to walk at. */
  bodyDef: TileDef;
  equipment: Equipment | null;
  tilesById: Record<string, TileDef>;
  statuses: readonly StatusInstance[];
  statusDefs: Record<string, StatusDef>;
  hp: number | null;
}): Attributes {
  const base = effectiveBattler(
    body,
    equipment,
    tilesById,
    handToSwing(equipment, tilesById, REPORTED_HAND),
  );
  const stats = withStatusModifiers(
    base,
    statuses,
    statusDefs,
    hp ?? base.maxHp,
  );

  // Through `damageBand` rather than probing the roll here, because an item's
  // card reports the same band for a weapon on the floor — see `./itemCard` —
  // and two copies of "what are the ends of the draw" is two chances to round
  // the sword in your hand differently from the body holding it.
  const damage = damageBand(stats);

  return {
    minDamage: damage.min,
    maxDamage: damage.max,
    swingMs: swingIntervalMs(stats),
    hitChance: stats.hitChance,
    def: stats.def,
    flee: stats.flee,
    reach: shortReach(stats.reach),
    // **Statuses and not the ground.** The panel says what this body is, and
    // what is under its feet is where it happens to be standing: a reading that
    // changed as you crossed a bog would be answering a question about the
    // floor. A step actually taken is timed with both — see `./movement`'s
    // `groundWalkSpeedPercent`, which is the caller's half of that sum.
    walkPace:
      1000 /
      walkDurationMsFor(bodyDef, walkSpeedPercentFrom(statuses, statusDefs)),
  };
}

/**
 * A reach in the few characters the panel's grid has for one.
 *
 * `c` is cells, which is the unit {@link Attributes.walkPace} abbreviates the
 * same way — so "Range 2–8c" and "Move 5.0c/s" read against each other rather
 * than each carrying its own spelling of the world's one distance.
 */
function shortReach(reach: Reach): string {
  // The floor decides before the ceiling does, exactly as it does on a card: a
  // weapon you cannot use in somebody's face is not "Melee" however short the
  // rest of its reach.
  if (reach.min) return `${reach.min}–${reach.cells}c`;
  return reach.cells <= MELEE_REACH.cells ? "Melee" : `${reach.cells}c`;
}

/**
 * Whether two readings say the same thing.
 *
 * Field by field rather than by identity, because the block is rebuilt every
 * tick out of objects that are themselves rebuilt every tick — so identity says
 * "changed" always, and the panel would re-render on every frame of a world
 * where nothing about the body moved. Every field is a primitive, which is what
 * makes this cheap enough to ask at that rate. @see Attributes
 */
export function sameAttributes(
  a: Attributes | null,
  b: Attributes | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.minDamage === b.minDamage &&
    a.maxDamage === b.maxDamage &&
    a.swingMs === b.swingMs &&
    a.hitChance === b.hitChance &&
    a.def === b.def &&
    a.flee === b.flee &&
    a.reach === b.reach &&
    a.walkPace === b.walkPace
  );
}
