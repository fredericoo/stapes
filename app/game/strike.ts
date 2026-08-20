/**
 * How a blow moves the two bodies in it.
 *
 * Purely how a blow *looks* — nothing here decides whether one lands. It exists
 * because a fight drawn without it is unreadable: two bodies stand a cell apart,
 * numbers come off one of them, and nothing on screen says which of the two is
 * the one doing it.
 *
 * Two movements, and they are opposites of each other:
 *
 * - **A swing throws the attacker forward.** Owed for every blow struck within
 *   arm's reach, whatever it came to — see {@link swingToward}.
 * - **A dodge throws the defender back.** The blow that was avoided, said with
 *   the body instead of with a word — see {@link dodgeAway}.
 *
 * The pair is why a dodge no longer floats the word "dodge". A miss still does:
 * a miss is the *attacker* failing and there is nothing for the defender to act
 * out, so the only place to say it is in text. A dodge is the defender
 * succeeding, and a body getting out of the way says that better than a label
 * over its head ever did — it says *who* did it, and it says it where the eye
 * already is.
 */

import { DEFAULT_MELEE_RANGE } from "../lib/battler";
import { withinReach, type ReachPoint } from "./distance";

/**
 * How close the target has to be for the attacker to throw itself at them.
 *
 * **The melee box, exactly** — the eight cells around you plus half a level
 * either way, which is the shape `DEFAULT_MELEE_RANGE` was chosen to draw. Any
 * shorter and there is a body you are plainly standing next to that you swing at
 * without moving: a foe on the diagonal *and* up on a crate is 1.73 away in a
 * metric where height costs a whole cell, so a band of 1.5 would have left that
 * one blow leanless while its two neighbours leaned.
 *
 * Shared with the reach rather than a number of its own, and that is the point:
 * a swing you can make by reaching is a swing you should be seen reaching for.
 * What it deliberately excludes is everything past arm's length — a bow's blow
 * lands from five cells away and leaning half a tile at it would claim a contact
 * that never happened.
 */
export const STRIKE_RANGE_CELLS = DEFAULT_MELEE_RANGE;

/**
 * A body part-way through throwing itself at somebody.
 *
 * Deliberately without its progress, which travels beside it as an
 * `ActorSnapshot`'s `strikeProgress`: motion is announced on the wire by
 * *identity*, so a state rebuilt each tick to carry its own clock would read as
 * a brand new strike thirty times a second. Walking, falling and sliding all
 * learned this the same way — see AGENTS.md, "The wire is patches plus motion
 * events".
 *
 * The delta rather than the other body's id or cell, because by the time this is
 * drawn there may be nobody there to measure against: a killing blow takes its
 * target off the board on the same tick, and the attacker still owes the lean
 * that killed them.
 */
export type StrikeState = {
  /**
   * Which end of the blow this body is on.
   *
   * Read only to settle the one tick where a body is both — see
   * {@link outranksSwing}. Nothing draws it: a lean is a delta and a clock, and
   * where the delta came from makes no difference to the pixels.
   */
  kind: StrikeKind;
  /**
   * Which way to travel, as a delta on the plan — towards the other body for a
   * swing, away from it for a dodge.
   *
   * A *direction*, not a distance: how far a lean actually goes is half a cell
   * whatever these say, and an archer nine cells off produces a nine here and
   * the same half-cell hop as a fist. See `../render/strikeMotion`.
   */
  dx: number;
  dy: number;
  /** The same, in height units — two of them to a level. */
  dElev: number;
  elapsedMs: number;
};

/** A body throwing itself at somebody, or out of somebody's way. */
export type StrikeKind = "swing" | "dodge";

/**
 * The same two, as values. A union alone cannot be validated at a boundary, and
 * the wire is a boundary — see `../net/protocol`.
 */
export const STRIKE_KINDS: StrikeKind[] = ["swing", "dodge"];

/**
 * The lean one body owes for swinging at another, or null for a blow struck
 * from too far away to lean into.
 *
 * Null also for a swing at something in the exact same place, which is not a
 * defensive nicety: two bodies in one cell at one elevation give a direction of
 * nothing, and a lean of zero pixels is a frame of animation that says less than
 * no animation at all.
 */
export function swingToward(
  from: ReachPoint,
  to: ReachPoint,
): StrikeState | null {
  if (!withinReach(from, to, STRIKE_RANGE_CELLS)) return null;
  return leanBetween("swing", from, to);
}

/**
 * The hop a body makes getting out of the way of a blow.
 *
 * **Not gated on range, unlike a swing**, and that asymmetry is the point: this
 * is now the only account of a dodge anybody gets, so an arrow avoided at five
 * cells has to show something or the shot simply vanishes. A swing is gated
 * because a lunge claims a *contact*; a hop backwards claims nothing except that
 * something came from that direction, which is as true of an arrow as of a fist.
 *
 * The delta runs from the attacker to the defender, so the defender travels
 * along it — away.
 */
export function dodgeAway(
  defender: ReachPoint,
  attacker: ReachPoint,
): StrikeState | null {
  return leanBetween("dodge", attacker, defender);
}

/**
 * Does this state get to keep the body it is on for the rest of the tick?
 *
 * The one collision worth resolving: two bodies fighting each other can both
 * come up on the same tick, so a body may dodge one blow and throw another
 * within a single tick, and there is one lean between them. The dodge wins.
 *
 * **Because the dodge is the only account of itself.** A swallowed lunge costs
 * one frame of "who is attacking whom" in a fight that will answer the question
 * again a few ticks later; a swallowed dodge is a blow that avoided a body and
 * left nothing on screen at all — no number, no word, no movement.
 *
 * Only a dodge nobody has seen a frame of, which is what the clock says: leans
 * are aged before anything swings, so `elapsedMs` of zero means *started this
 * tick*. A dodge from four ticks ago is spent and has no claim on the next blow
 * this body throws.
 */
export function outranksSwing(state: StrikeState | null): boolean {
  return state !== null && state.kind === "dodge" && state.elapsedMs === 0;
}

function leanBetween(
  kind: StrikeKind,
  from: ReachPoint,
  to: ReachPoint,
): StrikeState | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dElev = to.elevAbs - from.elevAbs;
  if (dx === 0 && dy === 0 && dElev === 0) return null;

  return { kind, dx, dy, dElev, elapsedMs: 0 };
}
