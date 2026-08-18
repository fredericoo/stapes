import { resolveWeapon } from "./item";
import {
  MASTERIES,
  MASTERY_BRIDGE,
  type Masteries,
  type MasteryXp,
  masteriesFromXp,
  masteryLevel,
} from "./mastery";
import type { TileDef } from "./types";

/**
 * What a weapon feels like in your hands, in a sentence.
 *
 * **This is the whole of what a player is told about a requirement.** There was
 * a panel here once listing every mastery a weapon asked for against the one you
 * had — "Blade 3 / 5", in red — and it was a spreadsheet in a game that is meant
 * to be played by picking things up and finding out. A number tells you exactly
 * how far short you are, which is a thing to *compute against*; a sentence tells
 * you that you are short, which is a thing to go and *do something about*. The
 * arithmetic has not gone anywhere — `./mastery` still decides every blow — it
 * is simply no longer the interface.
 *
 * **The worst requirement speaks**, on exactly the terms `masteryRatio` uses it:
 * a sword asking Blade 35 and Toughness 20 fights the hands of whoever is
 * further behind on either, and a line reading off the mastery it *trains*
 * would tell a player their Blade is fine while the thing stays unswingable.
 *
 * **The bands are bridges, not fractions.** Every threshold here is a whole
 * number of {@link MASTERY_BRIDGE}s away from what the weapon asks, which is the
 * same argument that constant won in `./mastery`: as a fraction, "a quarter
 * short" is one point on a starter dagger and twenty on an endgame blade, so the
 * ladder a player climbs would have a different number of rungs at every tier.
 * In points it is the same ladder the whole way up.
 *
 * **Symmetric, and widening as it goes out**: one bridge, two, then four, the
 * same distances in both directions. The rungs spread because the precision
 * stops being worth anything at the ends — the difference between a weapon you
 * are two points short of and one you are four short of is a fight you can feel,
 * where the difference between fifteen and eighteen short is "no". And the first
 * band above meeting it lands exactly where a weapon stops teaching at full rate,
 * so "you can confidently wield it" and "this has little left to show you" are
 * one fact rather than two that drift apart.
 */

/**
 * A bridge past everything it asks, which is where it stops teaching you at full
 * rate.
 *
 * The same distance {@link MASTERY_BRIDGE} measures elsewhere, and deliberately
 * so — see `./mastery`'s `learningRate`. A weapon whose every requirement is this
 * far below you has passed its training ceiling on the mastery it teaches too,
 * because the worst margin being a bridge means all of them are.
 */
const CONFIDENT_MARGIN = MASTERY_BRIDGE;

/** Two bridges clear: two weapons' worth of progress past what it asks. */
const EASY_MARGIN = 2 * MASTERY_BRIDGE;

/** Four, at which point it is not a weapon you are using so much as carrying. */
const TOY_MARGIN = 4 * MASTERY_BRIDGE;

/** Short by a bridge or more, the mirror of {@link CONFIDENT_MARGIN}. */
const MOSTLY_MARGIN = -MASTERY_BRIDGE;

/** Short by two or more: no single weapon's worth of progress closes it. */
const HARDLY_MARGIN = -2 * MASTERY_BRIDGE;

/** Short by four or more, and the bottom of the ladder — everything below reads alike. */
const BARELY_MARGIN = -4 * MASTERY_BRIDGE;

/**
 * How far past what it asks you are, in mastery points, worst requirement first.
 *
 * Null where the weapon asks nothing at all, which is not the same as a margin
 * of zero: an unrequirement is a fact about the weapon rather than about you,
 * and there is nothing to say about it. A requirement of zero reads as absent on
 * the same terms `masteryLevel` reads an unwritten mastery as zero.
 *
 * Points rather than a ratio, unlike `masteryRatio`, and the two are answering
 * different questions on purpose: the ratio scales a blow, where this places you
 * on a ladder whose rungs have to be the same height at every tier.
 */
export function masteryMargin(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number | null {
  if (!requirements) return null;

  let worst: number | null = null;
  for (const mastery of MASTERIES) {
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    const margin = masteryLevel(masteries, mastery) - required;
    if (worst === null || margin < worst) worst = margin;
  }
  return worst;
}

/**
 * What inspecting this weapon says, or null when it has nothing to say.
 *
 * Second person and present tense throughout, because it is the answer to a
 * question the player just asked by looking — "what would this be like?" — and
 * not a property of the object.
 */
export function weaponFeel(
  masteries: Masteries,
  requirements: Masteries | undefined,
): string | null {
  const margin = masteryMargin(masteries, requirements);
  if (margin === null) return null;

  if (margin >= TOY_MARGIN) return "You can wield it like a toy";
  if (margin >= EASY_MARGIN) return "You can easily wield it";
  if (margin >= CONFIDENT_MARGIN) return "You can confidently wield it";
  // The band around the gate itself, and the only line with no adverb in it:
  // inside a bridge either way the weapon is simply the weapon, which is what
  // meeting a requirement is supposed to feel like.
  if (margin > MOSTLY_MARGIN) return "You can wield it";
  if (margin > HARDLY_MARGIN) return "You can mostly wield it";
  if (margin > BARELY_MARGIN) return "You can hardly wield it";
  return "You can barely wield it";
}

/**
 * The same sentence, for a tile and a block of earned experience.
 *
 * Both places a weapon describes itself go through here — the look label in the
 * world and a slot in a panel — so the sword on the floor and the sword in your
 * bag cannot come to say different things about the same hands. Levels are read
 * out of the experience rather than passed in, on the same grounds `./mastery`
 * gives for the experience being what travels: there is one place a level is
 * derived and it is not here.
 *
 * Null for anything that is not a weapon, which is most of what a player can
 * point at.
 */
export function weaponFeelFor(
  def: TileDef | undefined,
  masteryXp: MasteryXp,
): string | null {
  const weapon = def ? resolveWeapon(def) : null;
  if (!weapon) return null;
  return weaponFeel(masteriesFromXp(masteryXp), weapon.requirements);
}
