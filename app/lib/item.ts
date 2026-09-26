import * as v from "valibot";
import { type Element, ELEMENTS } from "./element";
import {
  type Masteries,
  MASTERIES,
  masteriesSchema,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "./mastery";
import { HEIGHT_PER_LEVEL, type TileDef } from "./types";

export type Reach = {
  cells: number;
  min?: number;
  height: number;
};

export const MELEE_REACH: Reach = { cells: 1.5, height: HEIGHT_PER_LEVEL / 2 };

export type WeaponItem = {
  type: "weapon";
  name?: string;
  damage: number;
  def: number;
  accuracy: number;
  variance: number;
  spd: number;
  reach: Reach;
  twoHanded?: boolean;
  mastery: WeaponMastery;
  projectile?: string;
  requirements?: Masteries;
  statuses?: WeaponStatus[];
  elements?: Element[];
};

export type ConsumableItem = {
  type: "consumable";
  label?: string;
  hp: number;
  sound?: string;
  statuses?: StatusGrant[];
  pile?: number;
  leaves?: string;
};

export type StatusGrant = {
  id: string;
  chance?: number;
  fromMs?: number;
  toMs?: number;
};

export type WeaponStatus = StatusGrant & { chance: number };

export type ContainerItem = {
  type: "container";
  size: number;
  equippable: boolean;
};

export const ARMOR_SLOTS = ["head", "armor", "footwear", "charm"] as const;

export type ArmorSlot = (typeof ARMOR_SLOTS)[number];

export const DEFAULT_ARMOR_SLOT: ArmorSlot = "armor";

export function armorSlotOf(armor: ArmorItem): ArmorSlot {
  return armor.slot ?? DEFAULT_ARMOR_SLOT;
}

export type ArmorItem = {
  type: "armor";
  slot?: ArmorSlot;
  def: number;
  resist?: WeaponResistances;
  elements?: Element[];
};

export type WeaponResistances = Partial<Record<WeaponMastery, number>>;

export type ArtifactItem = {
  type: "artifact";
  pile?: number;
};

export type ShieldItem = {
  type: "shield";
  def: number;
  elements?: Element[];
};

export type StoneEffect =
  | {
      kind: "bolt";
      damage?: number;
      on: StoneSubject;
      variance?: number;
      projectile?: string;
      statuses?: WeaponStatus[];
    }
  | { kind: "conjure"; tileId: string };

export type StoneSubject = "caster" | "target";

export const STONE_SUBJECTS: StoneSubject[] = ["caster", "target"];

export const STONE_EFFECT_KINDS = ["bolt", "conjure"] as const;

export type StoneEffectKind = (typeof STONE_EFFECT_KINDS)[number];

export type ArcaneStoneItem = {
  type: "stone";
  effect: StoneEffect;
  cooldownMs: number;
  castTimeMs?: number;
  uninterruptible?: boolean;
  sound?: string;
  requirements?: Masteries;
  reach?: Reach;
  elements?: Element[];
};

export type CharmItem = {
  type: "charm";
  everyMs: number;
  hp?: number;
  statuses?: StatusGrant[];
  elements?: Element[];
};

export type ItemDef =
  | WeaponItem
  | ConsumableItem
  | ContainerItem
  | ArmorItem
  | ShieldItem
  | ArtifactItem
  | ArcaneStoneItem
  | CharmItem;

export type ItemType = ItemDef["type"];

export const MIN_PERCENT_STAT = 0;
export const MAX_PERCENT_STAT = 100;

export const MAX_WEAPON_DAMAGE = 999;

export const MAX_REACH_CELLS = 64;
export const MAX_REACH_HEIGHT = 20;

export const DEFAULT_WEAPON_STATUS_CHANCE = 10;

export const MAX_CONTAINER_SIZE = 12;

export const MAX_ARMOR_DEF = MAX_WEAPON_DAMAGE;

export const MAX_CONSUMABLE_HP_SHIFT = 999;

export const CONSUME_FALLBACK_VERB = "Use";

export const MAX_SOUND_LENGTH = 32;

export const MIN_PILE = 1;
export const MAX_PILE = 99;

export const DEFAULT_PILE = 8;

export function consumeVerb(consumable: ConsumableItem): string {
  return consumable.label?.trim() || CONSUME_FALLBACK_VERB;
}

export function pileOf(consumable: { pile?: number }): number {
  return consumable.pile ?? DEFAULT_PILE;
}

export function pileMax(def: TileDef): number {
  const item = resolveItem(def);
  if (item?.type === "consumable") return pileOf(item);
  if (item?.type === "artifact") return item.pile ?? MIN_PILE;
  return MIN_PILE;
}

export function equipVerb(def: TileDef): string {
  const item = resolveItem(def);
  if (!item) return EQUIP_FALLBACK_VERB;
  if (item.type === "container") return "Put on";
  if (item.type === "armor") return "Wear";
  if (item.type === "weapon") return "Wield";
  return "Hold";
}

export const EQUIP_FALLBACK_VERB = "Equip";

export const UNNAMED_WEAPON = "A blow";

export const UNNAMED_SPELL = "A spell";

export const DEFAULT_WEAPON: WeaponItem = {
  type: "weapon",
  damage: 4,
  def: 0,
  accuracy: 85,
  variance: 20,
  spd: 50,
  reach: { ...MELEE_REACH },
  mastery: "sharp",
};

export const DEFAULT_CONSUMABLE: ConsumableItem = {
  type: "consumable",
  label: "Eat",
  hp: 5,
  sound: "crunch",
  pile: DEFAULT_PILE,
};

export const DEFAULT_ARMOR: ArmorItem = {
  type: "armor",
  def: 2,
};

export const DEFAULT_CONTAINER: ContainerItem = {
  type: "container",
  size: 4,
  equippable: true,
};

export const DEFAULT_ARTIFACT: ArtifactItem = { type: "artifact" };

export const DEFAULT_SHIELD: ShieldItem = { type: "shield", def: 2 };

export const MIN_STONE_COOLDOWN_MS = 1_000;
export const MAX_STONE_COOLDOWN_MS = 60 * 60 * 1000;

export const MIN_CAST_TIME_MS = 200;
export const MAX_CAST_TIME_MS = 60 * 1000;

export const MAX_SPELL_DAMAGE = MAX_CONSUMABLE_HP_SHIFT;

export const MIN_CHARM_INTERVAL_MS = 1_000;
export const MAX_CHARM_INTERVAL_MS = 60 * 60 * 1000;

export const MAX_CHARM_HP = 10;

export const DEFAULT_CHARM: CharmItem = { type: "charm", everyMs: 10_000, hp: 1 };

export const DEFAULT_STONE: ArcaneStoneItem = {
  type: "stone",
  effect: { kind: "bolt", damage: -5, on: "caster" },
  cooldownMs: 10_000,
};

const percent = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_PERCENT_STAT),
  v.maxValue(MAX_PERCENT_STAT),
);

const statusGrantEntries = {
  id: v.pipe(v.string(), v.trim(), v.minLength(1)),
  fromMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  toMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  chance: v.optional(percent),
};

type DurationOverride = { fromMs?: number; toMs?: number };

const overrideIsWhole = (raw: DurationOverride) =>
  (raw.fromMs === undefined) === (raw.toMs === undefined);

const overrideIsOrdered = (raw: DurationOverride) =>
  raw.fromMs === undefined || raw.toMs! >= raw.fromMs;

const BOTH_ENDS_MESSAGE = "give both ends of a duration override, or neither";
const ORDERED_MESSAGE = "duration range is inverted";

const statusGrantSchema = v.pipe(
  v.object(statusGrantEntries),
  v.check((raw) => overrideIsWhole(raw), BOTH_ENDS_MESSAGE),
  v.check((raw) => overrideIsOrdered(raw), ORDERED_MESSAGE),
);

const weaponStatusSchema = v.pipe(
  v.object({ ...statusGrantEntries, chance: percent }),
  v.check((raw) => overrideIsWhole(raw), BOTH_ENDS_MESSAGE),
  v.check((raw) => overrideIsOrdered(raw), ORDERED_MESSAGE),
);

const REACH_ORDERED_MESSAGE = "minimum reach is beyond the maximum";

const reachEntries = v.pipe(
  v.object({
    cells: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_CELLS)),
    min: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_CELLS))),
    height: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_HEIGHT)),
  }),
  v.check((raw) => (raw.min ?? 0) <= raw.cells, REACH_ORDERED_MESSAGE),
);

const projectileSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

const elementsSchema = v.array(v.picklist(ELEMENTS));

export const weaponSchema = v.object({
  type: v.literal("weapon"),
  name: v.optional(v.string()),
  damage: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_WEAPON_DAMAGE)),
  def: v.pipe(v.number(), v.integer(), v.minValue(0)),
  twoHanded: v.optional(v.boolean()),
  accuracy: percent,
  variance: percent,
  spd: percent,
  reach: v.optional(reachEntries, () => ({ ...MELEE_REACH })),
  mastery: v.picklist(WEAPON_MASTERIES),
  projectile: v.optional(projectileSchema),
  requirements: v.optional(masteriesSchema),
  statuses: v.optional(v.array(weaponStatusSchema)),
  elements: v.optional(elementsSchema),
});

const consumableSchema = v.object({
  type: v.literal("consumable"),
  label: v.optional(v.string()),
  sound: v.optional(v.pipe(v.string(), v.maxLength(MAX_SOUND_LENGTH))),
  hp: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(-MAX_CONSUMABLE_HP_SHIFT),
    v.maxValue(MAX_CONSUMABLE_HP_SHIFT),
  ),
  statuses: v.optional(v.array(statusGrantSchema)),
  pile: v.optional(v.pipe(v.number(), v.integer(), v.minValue(MIN_PILE), v.maxValue(MAX_PILE))),
  leaves: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
});

const containerSchema = v.object({
  type: v.literal("container"),
  size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CONTAINER_SIZE)),
  equippable: v.boolean(),
});

const weaponResistancesSchema = v.object(
  Object.fromEntries(
    WEAPON_MASTERIES.map((mastery) => [
      mastery,
      v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ARMOR_DEF))),
    ]),
  ) as Record<
    WeaponMastery,
    v.OptionalSchema<
      v.SchemaWithPipe<
        [
          v.NumberSchema<undefined>,
          v.IntegerAction<number, undefined>,
          v.MinValueAction<number, number, undefined>,
          v.MaxValueAction<number, number, undefined>,
        ]
      >,
      undefined
    >
  >,
);

const armorSchema = v.object({
  type: v.literal("armor"),
  slot: v.optional(v.picklist(ARMOR_SLOTS)),
  def: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ARMOR_DEF)),
  resist: v.optional(weaponResistancesSchema),
  elements: v.optional(elementsSchema),
});

const artifactSchema = v.object({
  type: v.literal("artifact"),
  pile: v.optional(v.pipe(v.number(), v.integer(), v.minValue(MIN_PILE), v.maxValue(MAX_PILE))),
});

const shieldSchema = v.object({
  type: v.literal("shield"),
  def: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ARMOR_DEF)),
  elements: v.optional(elementsSchema),
});

const EMPTY_BOLT_MESSAGE = "A bolt has to move health or leave a status behind.";

const stoneEffectSchema = v.variant("kind", [
  v.pipe(
    v.object({
      kind: v.literal("bolt"),
      damage: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(-MAX_SPELL_DAMAGE),
          v.maxValue(MAX_SPELL_DAMAGE),
          v.check((damage) => damage !== 0, "A bolt of zero moves no health."),
        ),
      ),
      on: v.picklist(STONE_SUBJECTS),
      variance: v.optional(percent),
      projectile: v.optional(projectileSchema),
      statuses: v.optional(v.array(weaponStatusSchema)),
    }),
    v.check(
      (raw) => raw.damage !== undefined || (raw.statuses?.length ?? 0) > 0,
      EMPTY_BOLT_MESSAGE,
    ),
  ),
  v.object({
    kind: v.literal("conjure"),
    tileId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
]);

export const stoneSchema = v.object({
  type: v.literal("stone"),
  effect: stoneEffectSchema,
  cooldownMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(MIN_STONE_COOLDOWN_MS),
    v.maxValue(MAX_STONE_COOLDOWN_MS),
  ),
  castTimeMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(MIN_CAST_TIME_MS), v.maxValue(MAX_CAST_TIME_MS)),
  ),
  uninterruptible: v.optional(v.boolean()),
  sound: v.optional(v.pipe(v.string(), v.maxLength(MAX_SOUND_LENGTH))),
  requirements: v.optional(masteriesSchema),
  reach: v.optional(reachEntries),
  elements: v.optional(elementsSchema),
});

const charmSchema = v.object({
  type: v.literal("charm"),
  everyMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(MIN_CHARM_INTERVAL_MS),
    v.maxValue(MAX_CHARM_INTERVAL_MS),
  ),
  hp: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CHARM_HP))),
  statuses: v.optional(v.array(statusGrantSchema)),
  elements: v.optional(elementsSchema),
});

const itemSchema = v.variant("type", [
  weaponSchema,
  armorSchema,
  shieldSchema,
  consumableSchema,
  containerSchema,
  artifactSchema,
  stoneSchema,
  charmSchema,
]);

const itemCache = new WeakMap<TileDef, ItemDef | null>();

export function resolveItem(def: TileDef): ItemDef | null {
  const cached = itemCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.kind === "item" ? def.interactions?.item : undefined;
  const parsed = raw == null ? null : v.safeParse(itemSchema, raw);
  const item = parsed?.success ? (parsed.output as ItemDef) : null;
  itemCache.set(def, item);
  return item;
}

export function isItem(def: TileDef): boolean {
  return resolveItem(def) !== null;
}

export function resolveContainer(def: TileDef): ContainerItem | null {
  const item = resolveItem(def);
  return item?.type === "container" ? item : null;
}

export function resolveArmor(def: TileDef): ArmorItem | null {
  const item = resolveItem(def);
  return item?.type === "armor" ? item : null;
}

export function isTwoHanded(def: TileDef): boolean {
  return resolveWeapon(def)?.twoHanded === true;
}

export function resolveShield(def: TileDef): ShieldItem | null {
  const item = resolveItem(def);
  return item?.type === "shield" ? item : null;
}

export function resolveStone(def: TileDef): ArcaneStoneItem | null {
  const item = resolveItem(def);
  return item?.type === "stone" ? item : null;
}

export function resolveCharm(def: TileDef): CharmItem | null {
  const item = resolveItem(def);
  return item?.type === "charm" ? item : null;
}

export function itemElements(def: TileDef): readonly Element[] {
  const item = resolveItem(def);
  if (!item || !("elements" in item) || !item.elements?.length) {
    return NO_ELEMENTS;
  }
  return item.elements;
}

export const NO_ELEMENTS: readonly Element[] = [];

export function isRanged(weapon: { projectile?: string | null }): boolean {
  return weapon.projectile != null;
}

export function resolveWeapon(def: TileDef): WeaponItem | null {
  const item = resolveItem(def);
  return item?.type === "weapon" ? item : null;
}

export function resolveConsumable(def: TileDef): ConsumableItem | null {
  const item = resolveItem(def);
  return item?.type === "consumable" ? item : null;
}

export function reachOf(weapon: { reach?: Reach }): Reach {
  return { ...MELEE_REACH, ...weapon.reach };
}

export function reachForSave(reach: Reach): Reach {
  const { min, ...rest } = reach;
  return min ? { ...rest, min } : rest;
}

export function weaponForSave(weapon: WeaponItem): WeaponItem {
  const requirements = Object.fromEntries(
    MASTERIES.filter((mastery) => (weapon.requirements?.[mastery] ?? 0) > 0).map((mastery) => [
      mastery,
      weapon.requirements?.[mastery],
    ]),
  );

  const statuses = statusGrantsForSave(weapon.statuses);

  const name = weapon.name?.trim();

  return {
    type: "weapon",
    ...(name ? { name } : {}),
    damage: weapon.damage,
    def: weapon.def,
    accuracy: weapon.accuracy,
    variance: weapon.variance,
    spd: weapon.spd,
    reach: reachForSave(reachOf(weapon)),
    mastery: weapon.mastery,
    ...(weapon.projectile?.trim() ? { projectile: weapon.projectile.trim() } : {}),
    ...(weapon.twoHanded ? { twoHanded: true } : {}),
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    ...(statuses ? { statuses } : {}),
    ...elementsForSave(weapon.elements),
  };
}

function statusGrantsForSave<Grant extends StatusGrant>(
  statuses: Grant[] | undefined,
): Grant[] | undefined {
  if (!statuses?.length) return undefined;
  const saved: Grant[] = [];
  for (const entry of statuses) {
    const id = entry.id.trim();
    if (!id) continue;
    const fromMs = entry.fromMs;
    const toMs = entry.toMs;
    if (fromMs !== undefined && toMs !== undefined) {
      saved.push({ ...entry, id, fromMs: Math.round(fromMs), toMs: Math.round(toMs) });
    } else {
      const { fromMs: _from, toMs: _to, ...rest } = entry;
      saved.push({ ...rest, id } as Grant);
    }
  }
  return saved.length ? saved : undefined;
}

function armorForSave(armor: ArmorItem): ArmorItem {
  const resist = Object.fromEntries(
    WEAPON_MASTERIES.filter((mastery) => (armor.resist?.[mastery] ?? 0) > 0).map((mastery) => [
      mastery,
      armor.resist?.[mastery],
    ]),
  );
  const slot = armorSlotOf(armor);
  return {
    type: "armor",
    ...(slot === DEFAULT_ARMOR_SLOT ? {} : { slot }),
    def: armor.def,
    ...(Object.keys(resist).length > 0 ? { resist } : {}),
    ...elementsForSave(armor.elements),
  };
}

export function itemForSave(item: ItemDef | undefined): ItemDef | undefined {
  if (!item) return undefined;
  if (item.type === "weapon") return weaponForSave(item);
  if (item.type === "armor") return armorForSave(item);
  if (item.type === "consumable") {
    const label = item.label?.trim();
    const sound = item.sound?.trim();
    const statuses = statusGrantsForSave(item.statuses);
    const leaves = item.leaves?.trim();
    return {
      type: "consumable",
      ...(label ? { label } : {}),
      ...(sound ? { sound } : {}),
      hp: item.hp,
      ...(statuses ? { statuses } : {}),
      ...(leaves ? { leaves } : {}),
      pile: pileOf(item),
    };
  }
  if (item.type === "artifact") {
    const pile = item.pile ?? MIN_PILE;
    return { type: "artifact", ...(pile > MIN_PILE ? { pile } : {}) };
  }
  if (item.type === "shield") {
    return { type: "shield", def: item.def, ...elementsForSave(item.elements) };
  }
  if (item.type === "stone") return stoneForSave(item);
  if (item.type === "charm") return charmForSave(item);
  return {
    type: "container",
    size: item.size,
    equippable: item.equippable,
  };
}

function charmForSave(charm: CharmItem): CharmItem {
  return {
    type: "charm",
    everyMs: Math.round(charm.everyMs),
    ...(charm.hp ? { hp: Math.round(charm.hp) } : {}),
    ...(charm.statuses?.length ? { statuses: statusGrantsForSave(charm.statuses) } : {}),
    ...elementsForSave(charm.elements),
  };
}

function elementsForSave(elements: Element[] | undefined) {
  if (!elements?.length) return {};
  const kept = ELEMENTS.filter((element) => elements.includes(element));
  return kept.length > 0 ? { elements: kept } : {};
}

export function stoneForSave(stone: ArcaneStoneItem): ArcaneStoneItem {
  const requirements = Object.fromEntries(
    MASTERIES.filter((mastery) => (stone.requirements?.[mastery] ?? 0) > 0).map((mastery) => [
      mastery,
      stone.requirements?.[mastery],
    ]),
  );

  const sound = stone.sound?.trim();

  return {
    type: "stone",
    effect: stoneEffectForSave(stone.effect),
    cooldownMs: Math.round(stone.cooldownMs),
    ...(stone.castTimeMs ? { castTimeMs: Math.round(stone.castTimeMs) } : {}),
    ...(stone.uninterruptible ? { uninterruptible: true } : {}),
    ...(sound ? { sound } : {}),
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    ...(stone.reach ? { reach: reachForSave(stone.reach) } : {}),
    ...elementsForSave(stone.elements),
  };
}

function stoneEffectForSave(effect: StoneEffect): StoneEffect {
  if (effect.kind === "conjure") {
    return { kind: "conjure", tileId: effect.tileId.trim() };
  }
  const statuses = statusGrantsForSave(effect.statuses);
  return {
    kind: "bolt",
    on: effect.on,
    ...(effect.damage ? { damage: Math.round(effect.damage) } : {}),
    ...(effect.variance ? { variance: Math.round(effect.variance) } : {}),
    ...(effect.projectile?.trim() ? { projectile: effect.projectile.trim() } : {}),
    ...(statuses ? { statuses } : {}),
  };
}
