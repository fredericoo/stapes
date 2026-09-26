import * as v from "valibot";
import { type Element, ELEMENTS } from "./element";
import {
  type ArcaneStoneItem,
  DEFAULT_WEAPON,
  MAX_PERCENT_STAT,
  MELEE_REACH,
  type Reach,
  stoneSchema,
  weaponSchema,
  type WeaponItem,
  type WeaponResistances,
  type WeaponStatus,
} from "./item";
import { type Kit, kitSchema } from "./kit";
import {
  type Masteries,
  masteriesSchema,
  masteryLevel,
  MAX_MASTERY,
  requirementShortfall,
  spellElements,
  type WeaponMastery,
} from "./mastery";
import { type AnchoredSprite, defaultBase, type TileDef } from "./types";

export type BattlerDef = {
  baseHp: number;
  masteries: Masteries;
  naturalWeapon: WeaponItem;
  sight: { up: number; down: number };
  kit?: Kit;
  elements?: Element[];
  immuneTo?: string[];
  remains?: string;
  spells?: NaturalSpell[];
};

export type NaturalSpell = ArcaneStoneItem & {
  name: string;
  icon?: AnchoredSprite;
};

export type FightingStats = {
  maxHp: number;
  damage: number;
  def: number;
  resist: WeaponResistances;
  accuracy: number;
  variance: number;
  spd: number;
  mastery: WeaponMastery;
  haste: number;
  hitChance: number;
  flee: number;
  reach: Reach;
  projectile: string | null;
  sight: { up: number; down: number };
  statuses: readonly WeaponStatus[];
};

export const DEFAULT_BASE_HP = 8;

export const MIN_BASE_HP = 1;
export const MAX_BASE_HP = 100000;

export const HP_PER_TOUGHNESS = 1;

export const MASTERY_ACCELERATION = 3;

export const DEF_AT_MAX_TOUGHNESS = 20;

export const FLEE_BASE = 20;

export const FLEE_PER_AGILITY = 1;

export const MIN_CHANCE = 0.05;
export const MAX_CHANCE = 0.95;

export function clampChance(chance: number): number {
  return Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, chance));
}

function acceleratingTotal(level: number, atMax: number, acceleration: number): number {
  const reach = Math.max(0, level);
  const first = (2 * atMax) / (MAX_MASTERY * (acceleration + 1));
  const curve = (first * (acceleration - 1)) / (2 * MAX_MASTERY);
  return first * reach + curve * reach * reach;
}

export const HP_AT_MAX_TOUGHNESS =
  (HP_PER_TOUGHNESS * MAX_MASTERY * (MASTERY_ACCELERATION + 1)) / 2;

export function maxHpFrom(baseHp: number, toughness: number): number {
  return (
    baseHp + Math.round(acceleratingTotal(toughness, HP_AT_MAX_TOUGHNESS, MASTERY_ACCELERATION))
  );
}

export function defFrom(toughness: number): number {
  return Math.round(acceleratingTotal(toughness, DEF_AT_MAX_TOUGHNESS, MASTERY_ACCELERATION));
}

export const HASTE_AT_MAX_AGILITY = 2;

export function hasteFrom(agility: number): number {
  return 1 + acceleratingTotal(agility, HASTE_AT_MAX_AGILITY, MASTERY_ACCELERATION);
}

export function fleeFrom(agility: number): number {
  return FLEE_BASE + Math.round(FLEE_PER_AGILITY * agility);
}

export const HANDLING_PER_POINT_SHORT = 0.05;

export const MIN_HANDLING = 0.15;

export function weaponHandling(shortfall: number): number {
  return Math.max(MIN_HANDLING, 1 - HANDLING_PER_POINT_SHORT * Math.max(0, shortfall));
}

export const MASTERY_DAMAGE_BONUS = 0.25;
export const DAMAGE_AT_MAX_MASTERY = 20;
export const MASTERY_ACCURACY_BONUS = 0.25;
export const ACCURACY_AT_MAX_MASTERY = 5;

export function damageAtMastery(weapon: WeaponItem, level: number): number {
  if (weapon.damage <= 0) return 0;
  const skill = level / MAX_MASTERY;
  return weapon.damage * (1 + skill * MASTERY_DAMAGE_BONUS) + skill * DAMAGE_AT_MAX_MASTERY;
}

export function hitChanceFrom(accuracy: number): number {
  return clampChance(accuracy / MAX_PERCENT_STAT);
}

export const DEFAULT_BATTLER: BattlerDef = {
  baseHp: DEFAULT_BASE_HP,
  masteries: { fist: 8, toughness: 8, agility: 8 },
  naturalWeapon: { ...DEFAULT_WEAPON, mastery: "fist", reach: { ...MELEE_REACH } },
  sight: { up: 0, down: 0 },
  kit: [],
};

export function bodyDefence(battler: BattlerDef): number {
  return defFrom(masteryLevel(battler.masteries, "toughness"));
}

export function fightingStats(battler: BattlerDef, weapon: WeaponItem): FightingStats {
  const handling = weaponHandling(requirementShortfall(battler.masteries, weapon.requirements));

  const skill = masteryLevel(battler.masteries, weapon.mastery) / MAX_MASTERY;

  const damage = damageAtMastery(weapon, masteryLevel(battler.masteries, weapon.mastery));
  const accuracy =
    handling *
    (weapon.accuracy * (1 + skill * MASTERY_ACCURACY_BONUS) + skill * ACCURACY_AT_MAX_MASTERY);

  return {
    maxHp: maxHpFrom(battler.baseHp, masteryLevel(battler.masteries, "toughness")),
    flee: fleeFrom(masteryLevel(battler.masteries, "agility")),
    damage: Math.round(damage),
    def: weapon.def + bodyDefence(battler),
    resist: NO_RESISTANCES,
    mastery: weapon.mastery,
    accuracy: Math.round(accuracy),
    hitChance: hitChanceFrom(accuracy),
    variance: weapon.variance,
    haste: hasteFrom(masteryLevel(battler.masteries, "agility")) * handling,
    spd: weapon.spd,
    reach: weapon.reach,
    projectile: weapon.projectile ?? null,
    sight: battler.sight,
    statuses: weapon.statuses ?? NO_WEAPON_STATUSES,
  };
}

const NO_WEAPON_STATUSES: readonly WeaponStatus[] = [];

export const NO_RESISTANCES: WeaponResistances = {};

export function castingSkill(masteries: Masteries, requirements: Masteries | undefined): number {
  const elements = spellElements(requirements);
  let total = masteryLevel(masteries, "arcane");
  for (const element of elements) total += masteryLevel(masteries, element);
  return total / ((1 + elements.length) * MAX_MASTERY);
}

export function spellPower(
  damage: number,
  requirements: Masteries | undefined,
  masteries: Masteries,
): number {
  if (damage === 0) return 0;
  const skill = castingSkill(masteries, requirements);
  const magnitude =
    Math.abs(damage) * (1 + skill * MASTERY_DAMAGE_BONUS) + skill * DAMAGE_AT_MAX_MASTERY;
  return damage < 0 ? -magnitude : magnitude;
}

export const MAX_SPELL_NAME_LENGTH = 48;

export const DEFAULT_SPELL_NAME = "Spell";

const levelSlack = v.pipe(v.number(), v.integer(), v.minValue(0));

const iconSchema = v.pipe(
  v.object({
    tilesetId: v.string(),
    rect: v.object({
      x: v.pipe(v.number(), v.integer(), v.minValue(0)),
      y: v.pipe(v.number(), v.integer(), v.minValue(0)),
      w: v.pipe(v.number(), v.integer(), v.minValue(1)),
      h: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    base: v.optional(
      v.object({
        x: v.pipe(v.number(), v.integer(), v.minValue(0)),
        y: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
  }),
  v.transform((raw): AnchoredSprite => ({
    ...raw,
    base: raw.base ?? defaultBase(raw.rect),
  })),
);

const battlerSchema = v.object({
  baseHp: v.pipe(v.number(), v.integer(), v.minValue(MIN_BASE_HP), v.maxValue(MAX_BASE_HP)),
  masteries: masteriesSchema,
  naturalWeapon: weaponSchema,
  sight: v.optional(v.object({ up: levelSlack, down: levelSlack }), () => ({ up: 0, down: 0 })),
  kit: v.optional(kitSchema, () => []),
  elements: v.optional(v.array(v.picklist(ELEMENTS))),
  immuneTo: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  remains: v.optional(v.pipe(v.string(), v.minLength(1))),
  spells: v.optional(
    v.array(
      v.object({
        ...stoneSchema.entries,
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_SPELL_NAME_LENGTH)),
        icon: v.optional(iconSchema),
      }),
    ),
    () => [],
  ),
});

const battlerCache = new WeakMap<TileDef, BattlerDef | null>();

export function resolveBattler(def: TileDef): BattlerDef | null {
  const cached = battlerCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.kind === "battler" ? def.interactions?.battler : undefined;
  const parsed = raw == null ? null : v.safeParse(battlerSchema, raw);
  const battler = parsed?.success ? (parsed.output as BattlerDef) : null;
  battlerCache.set(def, battler);
  return battler;
}

export function battlerIssues(def: TileDef): string[] {
  if (def.kind !== "battler") return [];
  const raw = def.interactions?.battler;
  if (raw == null) return ["battler: missing — this tile's kind is battler but it has no block"];
  const parsed = v.safeParse(battlerSchema, raw);
  if (parsed.success) return [];
  return parsed.issues.map((issue) => `${issuePath(issue.path) || "battler"}: ${issue.message}`);
}

function issuePath(path: ReadonlyArray<{ key: unknown }> | undefined): string {
  return (path ?? []).reduce<string>((joined, { key }) => {
    if (typeof key === "number") return `${joined}[${key}]`;
    return joined ? `${joined}.${String(key)}` : String(key);
  }, "");
}

export function isBattler(def: TileDef): boolean {
  return resolveBattler(def) !== null;
}
