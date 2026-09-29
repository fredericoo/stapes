import * as v from "valibot";
import { levelForXp, MASTERIES, type Mastery, type MasteryXp } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { type Equipment, packSlots } from "./equipment";

export type LevelLost = {
  mastery: Mastery;
  from: number;
  to: number;
};

export type DeathCost = {
  packLeft: boolean;
  levelsLost: readonly LevelLost[];
};

export const deathCostSchema = v.object({
  packLeft: v.boolean(),
  levelsLost: v.array(
    v.object({ mastery: v.picklist(MASTERIES), from: v.number(), to: v.number() }),
  ),
});

export const NOTHING_LOST: DeathCost = Object.freeze({
  packLeft: false,
  levelsLost: Object.freeze([]),
});

type Belongings = {
  equipment: Equipment;
  masteryXp: MasteryXp;
};

export function deathCost(
  before: Belongings,
  after: Belongings,
  tilesById: Record<string, TileDef>,
): DeathCost {
  const levelsLost: LevelLost[] = [];
  for (const mastery of MASTERIES) {
    const from = levelForXp(before.masteryXp[mastery] ?? 0);
    const to = levelForXp(after.masteryXp[mastery] ?? 0);
    if (to < from) levelsLost.push({ mastery, from, to });
  }
  const packsBefore = packSlots(before.equipment, tilesById).length;
  const packsAfter = packSlots(after.equipment, tilesById).length;
  return { packLeft: packsAfter < packsBefore, levelsLost };
}
