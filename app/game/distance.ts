import type { Reach } from "../lib/item";

export type ReachPoint = { x: number; y: number; elevAbs: number };

export function planDistanceSq(from: ReachPoint, to: ReachPoint): number {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  return dx * dx + dy * dy;
}

export function heightApart(from: ReachPoint, to: ReachPoint): number {
  return Math.abs(from.elevAbs - to.elevAbs);
}

export function withinReach(from: ReachPoint, to: ReachPoint, reach: Reach): boolean {
  if (heightApart(from, to) > reach.height) return false;
  const planSq = planDistanceSq(from, to);
  if (planSq > reach.cells * reach.cells) return false;
  const min = reach.min ?? 0;
  return planSq >= min * min;
}
