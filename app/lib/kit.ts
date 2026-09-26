import * as v from "valibot";
import { ARMOR_SLOTS, MAX_CONTAINER_SIZE } from "./item";

export const EQUIP_SLOTS = [
  "head",
  "weapon",
  "offhand",
  "armor",
  "charm",
  "footwear",
  "bag",
] as const;

export type EquipSlot = (typeof EQUIP_SLOTS)[number];

const _everyArmorSlotIsWorn: readonly EquipSlot[] = ARMOR_SLOTS;

export const SLOT_LABELS: Record<EquipSlot, string> = {
  head: "Head",
  weapon: "Weapon hand",
  offhand: "Off hand",
  armor: "Body",
  charm: "Accessory",
  footwear: "Feet",
  bag: "Back",
};

export const MIN_KIT_CHANCE = 0;
export const MAX_KIT_CHANCE = 100;

export const DEFAULT_KIT_CHANCE = MAX_KIT_CHANCE;

export type KitContent = {
  tileId: string;
  chance: number;
};

export type KitEntry = KitContent & {
  slot: EquipSlot;
  contents?: KitContent[];
};

export type Kit = KitEntry[];

export const MAX_KIT_ENTRIES = (EQUIP_SLOTS.length + MAX_CONTAINER_SIZE) * 2;

const tileIdSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

const chanceSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(MIN_KIT_CHANCE),
  v.maxValue(MAX_KIT_CHANCE),
);

const kitContentSchema = v.object({
  tileId: tileIdSchema,
  chance: chanceSchema,
});

const kitEntrySchema = v.object({
  slot: v.picklist(EQUIP_SLOTS),
  tileId: tileIdSchema,
  chance: chanceSchema,
  contents: v.optional(v.array(kitContentSchema)),
});

export const kitSchema = v.fallback(
  v.pipe(v.array(kitEntrySchema), v.maxLength(MAX_KIT_ENTRIES)),
  () => [],
);

export function kitForSave(kit: Kit | undefined): Kit | undefined {
  const entries = (kit ?? []).flatMap((entry) => {
    const tileId = entry.tileId.trim();
    if (!tileId) return [];
    const contents = (entry.contents ?? []).flatMap((content) => {
      const contentTileId = content.tileId.trim();
      if (!contentTileId) return [];
      return [{ tileId: contentTileId, chance: content.chance }];
    });
    return [
      {
        slot: entry.slot,
        tileId,
        chance: entry.chance,
        ...(contents.length > 0 ? { contents } : {}),
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
}
