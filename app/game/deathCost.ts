import * as v from "valibot";
import { levelForXp, MASTERIES, type Mastery, type MasteryXp } from "../lib/mastery";

export type LevelLost = {
  mastery: Mastery;
  from: number;
  to: number;
};

export type DeathCost = {
  levelsLost: readonly LevelLost[];
};

export const deathCostSchema = v.object({
  levelsLost: v.array(
    v.object({ mastery: v.picklist(MASTERIES), from: v.number(), to: v.number() }),
  ),
});

export const NOTHING_LOST: DeathCost = Object.freeze({
  levelsLost: Object.freeze([]),
});

export function deathCost(before: MasteryXp, after: MasteryXp): DeathCost {
  const levelsLost: LevelLost[] = [];
  for (const mastery of MASTERIES) {
    const from = levelForXp(before[mastery] ?? 0);
    const to = levelForXp(after[mastery] ?? 0);
    if (to < from) levelsLost.push({ mastery, from, to });
  }
  return { levelsLost };
}
