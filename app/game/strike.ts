import { MELEE_REACH } from "../lib/item";
import { withinReach, type ReachPoint } from "./distance";

export const STRIKE_REACH = MELEE_REACH;

export type StrikeState = {
  kind: StrikeKind;
  dx: number;
  dy: number;
  dElev: number;
  elapsedMs: number;
};

export type StrikeKind = "swing" | "dodge";

export const STRIKE_KINDS: StrikeKind[] = ["swing", "dodge"];

export function swingToward(from: ReachPoint, to: ReachPoint, ranged: boolean): StrikeState | null {
  if (ranged) return null;
  if (!withinReach(from, to, STRIKE_REACH)) return null;
  return leanBetween("swing", from, to);
}

export function dodgeAway(defender: ReachPoint, attacker: ReachPoint): StrikeState | null {
  return leanBetween("dodge", attacker, defender);
}

/**
 * Only a dodge with `elapsedMs` of zero, meaning it started this tick: leans
 * are aged before anything swings, so a dodge from an earlier tick has
 * already been drawn and has no claim on the next blow this body throws.
 */
export function outranksSwing(state: StrikeState | null): boolean {
  return state !== null && state.kind === "dodge" && state.elapsedMs === 0;
}

function leanBetween(kind: StrikeKind, from: ReachPoint, to: ReachPoint): StrikeState | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dElev = to.elevAbs - from.elevAbs;
  if (dx === 0 && dy === 0 && dElev === 0) return null;

  return { kind, dx, dy, dElev, elapsedMs: 0 };
}
