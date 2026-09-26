import * as v from "valibot";

import { type Element, ELEMENTS } from "./element";

export type WeaponMastery = "fist" | "sharp" | "blunt" | "ranged" | "arcane";

export type BodyMastery = "toughness" | "agility";

export type ElementMastery = Element;

export type Mastery = WeaponMastery | BodyMastery | ElementMastery;

export const WEAPON_MASTERIES: WeaponMastery[] = ["fist", "sharp", "blunt", "ranged", "arcane"];

export const BODY_MASTERIES: BodyMastery[] = ["toughness", "agility"];

export const MASTERIES: Mastery[] = [...WEAPON_MASTERIES, ...BODY_MASTERIES, ...ELEMENTS];

export const MASTERY_LABELS: Record<Mastery, string> = {
  fist: "Fist",
  sharp: "Sharp",
  blunt: "Blunt",
  ranged: "Ranged",
  arcane: "Arcane",
  toughness: "Toughness",
  agility: "Agility",
  fire: "Fire",
  water: "Water",
  nature: "Nature",
};

export const MIN_MASTERY = 0;
export const MAX_MASTERY = 100;

export type Masteries = Partial<Record<Mastery, number>>;

export function masteryLevel(masteries: Masteries, mastery: Mastery): number {
  return masteries[mastery] ?? MIN_MASTERY;
}

export function spellElements(requirements: Masteries | undefined): Element[] {
  if (!requirements) return [];
  return ELEMENTS.filter((element) => (requirements[element] ?? 0) > 0);
}

export const REQUIREMENTS_MET = 1;

export function meetsRequirements(
  masteries: Masteries,
  requirements: Masteries | undefined,
): boolean {
  if (!requirements) return true;
  return MASTERIES.every(
    (mastery) => masteryLevel(masteries, mastery) >= (requirements[mastery] ?? 0),
  );
}

export function requirementShare(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  if (!requirements) return REQUIREMENTS_MET;

  let asked = 0;
  let brought = 0;
  for (const mastery of MASTERIES) {
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    asked += required;
    brought += Math.min(required, masteryLevel(masteries, mastery));
  }

  if (asked === 0) return REQUIREMENTS_MET;
  return brought / asked;
}

export function requirementShortfall(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  if (!requirements) return 0;

  let missing = 0;
  for (let i = 0; i < MASTERIES.length; i++) {
    const mastery = MASTERIES[i]!;
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    missing += Math.max(0, required - masteryLevel(masteries, mastery));
  }
  return missing;
}

export function requirementCoverage(
  masteries: Masteries,
  requirements: Masteries | undefined,
): number {
  if (!requirements) return REQUIREMENTS_MET;

  let asked = 0;
  let brought = 0;
  for (const mastery of MASTERIES) {
    const required = requirements[mastery] ?? 0;
    if (required <= 0) continue;
    asked += required;
    brought += masteryLevel(masteries, mastery);
  }

  if (asked === 0) return REQUIREMENTS_MET;
  return brought / asked;
}

export type MasteryXp = Partial<Record<Mastery, number>>;

export const XP_FOR_FIRST_LEVEL = 4;

export function xpForLevel(level: number): number {
  return XP_FOR_FIRST_LEVEL * level * level;
}

export function levelForXp(xp: number): number {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / XP_FOR_FIRST_LEVEL));
  return Math.min(MAX_MASTERY, level);
}

export function progressToNextLevel(xp: number): number {
  const level = levelForXp(xp);
  if (level >= MAX_MASTERY) return 0;
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return Math.max(0, Math.min(1, (Math.max(0, xp) - from) / (to - from)));
}

export function hasExperience(xp: MasteryXp | undefined): xp is MasteryXp {
  if (!xp) return false;
  for (const mastery of MASTERIES) {
    if ((xp[mastery] ?? 0) > 0) return true;
  }
  return false;
}

export function masteriesFromXp(xp: MasteryXp): Masteries {
  const masteries: Masteries = {};
  for (const mastery of MASTERIES) {
    const level = levelForXp(xp[mastery] ?? 0);
    if (level > MIN_MASTERY) masteries[mastery] = level;
  }
  return masteries;
}

export function xpFromMasteries(masteries: Masteries): MasteryXp {
  const xp: MasteryXp = {};
  for (const mastery of MASTERIES) {
    const level = masteryLevel(masteries, mastery);
    if (level > MIN_MASTERY) xp[mastery] = xpForLevel(level);
  }
  return xp;
}

export const RATING_PER_BEST_WEAPON = 0.5;
export const RATING_PER_TOUGHNESS = 0.3;
export const RATING_PER_AGILITY = 0.2;

export const MIN_RATING = 1;

export const RATING_GLYPH = "*";

export function rating(masteries: Masteries): number {
  let bestWeapon = 0;
  for (const mastery of WEAPON_MASTERIES) {
    bestWeapon = Math.max(bestWeapon, masteryLevel(masteries, mastery));
  }
  const raw =
    RATING_PER_BEST_WEAPON * bestWeapon +
    RATING_PER_TOUGHNESS * masteryLevel(masteries, "toughness") +
    RATING_PER_AGILITY * masteryLevel(masteries, "agility");
  return Math.max(MIN_RATING, Math.round(raw));
}

export const NOTHING_BELOW_RATIO = 1 / 3;

export const BENEATH_YOU_EXPONENT = 5;

export const MAX_XP_MULTIPLIER = 2;

export function experienceMultiplier(theirRating: number, yourRating: number): number {
  const r = theirRating / Math.max(MIN_RATING, yourRating);
  if (r < NOTHING_BELOW_RATIO) return 0;
  if (r <= 1) return r ** BENEATH_YOU_EXPONENT;
  return Math.min(MAX_XP_MULTIPLIER, r * r);
}

export function standingIn(masteries: Masteries, mastery: Mastery): number {
  return BODY_MASTERIES.includes(mastery as BodyMastery)
    ? rating(masteries)
    : masteryLevel(masteries, mastery);
}

export function masteryMultiplier(
  theirRating: number,
  masteries: Masteries,
  mastery: Mastery,
): number {
  return experienceMultiplier(theirRating, standingIn(masteries, mastery));
}

const masteryLevelSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_MASTERY),
  v.maxValue(MAX_MASTERY),
);

export const masteriesSchema = v.object(
  Object.fromEntries(
    MASTERIES.map((mastery) => [mastery, v.optional(masteryLevelSchema)]),
  ) as Record<Mastery, v.OptionalSchema<typeof masteryLevelSchema, undefined>>,
);

const masteryXpSchema = v.pipe(v.number(), v.finite(), v.minValue(0));

export const masteryXpBlockSchema = v.object(
  Object.fromEntries(MASTERIES.map((mastery) => [mastery, v.optional(masteryXpSchema)])) as Record<
    Mastery,
    v.OptionalSchema<typeof masteryXpSchema, undefined>
  >,
);
