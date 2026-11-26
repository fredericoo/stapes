import type { BattlerDef } from "../lib/battler";
import { type Masteries, MASTERIES, withMasteryBonus } from "../lib/mastery";
import { MELEE_REACH, type Reach } from "../lib/item";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { arcaneResist, damageBand, swingIntervalMs } from "./combat";
import { type Equipment, effectiveBattler, handToSwing, wornMasteryBonus } from "./equipment";
import { walkDurationMsFor } from "./movement";
import { type StatusInstance, walkSpeedPercentFrom, withStatusModifiers } from "./statuses";

export type Attributes = {
  minDamage: number;
  maxDamage: number;
  swingMs: number;
  hitChance: number;
  def: number;
  resist: number;
  flee: number;
  reach: string;
  walkPace: number;
  masteryBonus: Masteries;
};

const REPORTED_HAND = "weapon";

export function attributesOf({
  body,
  bodyDef,
  equipment,
  tilesById,
  statuses,
  statusDefs,
  hp,
}: {
  body: BattlerDef;
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
    handToSwing(equipment, tilesById, REPORTED_HAND, body.masteries),
  );
  const stats = withStatusModifiers(base, statuses, statusDefs, hp ?? base.maxHp);
  const masteryBonus = wornMasteryBonus(equipment, tilesById, body.masteries);

  const damage = damageBand(stats);

  return {
    minDamage: damage.min,
    maxDamage: damage.max,
    swingMs: swingIntervalMs(stats),
    hitChance: stats.hitChance,
    def: stats.def,
    resist: arcaneResist(stats, withMasteryBonus(body.masteries, masteryBonus)),
    flee: stats.flee,
    reach: shortReach(stats.reach),
    walkPace: 1000 / walkDurationMsFor(bodyDef, walkSpeedPercentFrom(statuses, statusDefs)),
    masteryBonus,
  };
}

function shortReach(reach: Reach): string {
  if (reach.min) return `${reach.min}–${reach.cells}c`;
  return reach.cells <= MELEE_REACH.cells ? "Melee" : `${reach.cells}c`;
}

export function sameAttributes(a: Attributes | null, b: Attributes | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.minDamage === b.minDamage &&
    a.maxDamage === b.maxDamage &&
    a.swingMs === b.swingMs &&
    a.hitChance === b.hitChance &&
    a.def === b.def &&
    a.resist === b.resist &&
    a.flee === b.flee &&
    a.reach === b.reach &&
    a.walkPace === b.walkPace &&
    sameMasteries(a.masteryBonus, b.masteryBonus)
  );
}

function sameMasteries(a: Masteries, b: Masteries): boolean {
  return a === b || MASTERIES.every((mastery) => (a[mastery] ?? 0) === (b[mastery] ?? 0));
}
