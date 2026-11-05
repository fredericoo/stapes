import * as v from "valibot";
import { levelForXp, MASTERIES, type Mastery, type MasteryXp } from "../lib/mastery";

export type LevelLost = {
  mastery: Mastery;
  from: number;
  to: number;
};

export type DeathCost = {
  bagLeft: boolean;
  levelsLost: readonly LevelLost[];
};

/** `bagLeft` is optional because rows written while death was permanent do not carry it. */
export const deathCostSchema = v.object({
  bagLeft: v.optional(v.boolean(), false),
  levelsLost: v.array(
    v.object({ mastery: v.picklist(MASTERIES), from: v.number(), to: v.number() }),
  ),
});

export const NOTHING_LOST: DeathCost = Object.freeze({
  bagLeft: false,
  levelsLost: Object.freeze([]),
});

export function deathCost(before: MasteryXp, after: MasteryXp, bagLeft: boolean): DeathCost {
  const levelsLost: LevelLost[] = [];
  for (const mastery of MASTERIES) {
    const from = levelForXp(before[mastery] ?? 0);
    const to = levelForXp(after[mastery] ?? 0);
    if (to < from) levelsLost.push({ mastery, from, to });
  }
  return { bagLeft, levelsLost };
}
