import type { BattlerDef } from "../lib/battler";
import { MAX_PERCENT_STAT, MIN_PERCENT_STAT } from "../lib/battler";

/**
 * What carrying things does to a fight.
 *
 * Pure, and in `app/game/` beside `combat.ts` rather than in `app/lib/`, because
 * this is a rule of a fight rather than a shape on disk. Both ends read it: the
 * simulation to roll with, and the Item tab to say what a weapon is worth
 * without re-deriving the arithmetic beside it.
 */

/**
 * How much of a weapon's weight comes off speed, and how much off accuracy.
 *
 * Full rate against speed and half against accuracy, so a heavy weapon slows how
 * often you swing more than it spoils the blow you land — the two are different
 * complaints and a single rate would make them the same one. Named rather than
 * written as a `/ 2` at the call site, because the ratio is a balance decision
 * and the next person to change it should find one number.
 */
const SPEED_COST_PER_WEIGHT = 1;
const ACCURACY_COST_PER_WEIGHT = 0.5;

/** Speed this much weight costs, as a whole number of stat points. */
export function speedCostOf(weight: number): number {
  return Math.round(Math.max(0, weight) * SPEED_COST_PER_WEIGHT);
}

/** Accuracy this much weight costs, as a whole number of stat points. */
export function accuracyCostOf(weight: number): number {
  return Math.round(Math.max(0, weight) * ACCURACY_COST_PER_WEIGHT);
}

/** Hold a 0–100 stat inside its range after equipment has been spent against it. */
function clampPercent(value: number): number {
  return Math.max(MIN_PERCENT_STAT, Math.min(MAX_PERCENT_STAT, value));
}

/**
 * The stats a body actually fights with, once what it is carrying is counted.
 *
 * `atk` and `def` are unbounded above, exactly as the authored stats are — a
 * weapon is meant to make you hit harder than the tile says. The percent stats
 * are clamped, because they are read as probabilities downstream and a negative
 * accuracy is not a worse accuracy, it is a broken one.
 */
export function applyWeaponStats(
  base: BattlerDef,
  weapon: { atk: number; def: number; weight: number } | null,
): BattlerDef {
  if (!weapon) return base;
  return {
    ...base,
    atk: base.atk + weapon.atk,
    def: base.def + weapon.def,
    spd: clampPercent(base.spd - speedCostOf(weapon.weight)),
    acc: clampPercent(base.acc - accuracyCostOf(weapon.weight)),
  };
}
