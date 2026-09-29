import { weaponHandling } from "./battler";
import { resolveWeapon } from "./item";
import {
  type Masteries,
  MASTERIES,
  MASTERY_LABELS,
  requirementShortfall,
  masteriesFromXp,
  masteryLevel,
  type MasteryXp,
} from "./mastery";
import type { TileDef } from "./types";

export function weaponDemand(masteries: Masteries, requirements: Masteries | undefined): string[] {
  const asked = MASTERIES.filter((mastery) => (requirements?.[mastery] ?? 0) > 0);
  if (asked.length === 0) return [];

  const lines = asked.map((mastery) => {
    const required = requirements?.[mastery] ?? 0;
    const have = masteryLevel(masteries, mastery);
    return have >= required
      ? `${MASTERY_LABELS[mastery]} ${required} — met`
      : `${MASTERY_LABELS[mastery]} ${required} — you have ${have}`;
  });

  const handling = weaponHandling(requirementShortfall(masteries, requirements));
  lines.push(
    handling >= 1
      ? "Full accuracy and swing rate"
      : `${Math.round(handling * 100)}% accuracy and swing rate; full damage`,
  );
  return lines;
}

export function weaponDemandFor(def: TileDef | undefined, masteryXp: MasteryXp): string[] {
  const weapon = def ? resolveWeapon(def) : null;
  if (!weapon) return [];
  return weaponDemand(masteriesFromXp(masteryXp), weapon.requirements);
}
