import * as v from "valibot";
import { armorSlotOf, type ArmorItem } from "./item";
import type { EquipSlot } from "./kit";

export type Recolouring = "skin" | "hair";

/** The layers of a human, bottom to top, and the file each one's parts are drawn in. */
export const LAYERS = [
  { id: "base", label: "Body", file: "human_base.png", optional: false, recolour: ["skin"] },
  { id: "shoes", label: "Shoes", file: "human_shoes.png", optional: true, recolour: [] },
  { id: "clothes", label: "Clothes", file: "human_clothes.png", optional: true, recolour: [] },
  {
    id: "head",
    label: "Head",
    file: "human_heads.png",
    optional: false,
    recolour: ["skin", "hair"],
  },
  { id: "hat", label: "Hat", file: "human_hats.png", optional: true, recolour: [] },
] as const satisfies readonly {
  id: string;
  label: string;
  file: string;
  optional: boolean;
  recolour: readonly Recolouring[];
}[];

export type LayerId = (typeof LAYERS)[number]["id"];

/**
 * Every drawn part, by a name that tiles, items and characters can store.
 * `block` counts the 48×64 blocks of the layer's file left to right, top to
 * bottom, blank ones included, so a block is never renumbered by adding
 * another. Retire a part by blanking its block and dropping its entry; never
 * move a block.
 */
export const HUMAN_PARTS = [
  { id: "body", layer: "base", block: 0, label: "Body" },
  { id: "dark-boots", layer: "shoes", block: 0, label: "Dark boots" },
  { id: "brown-boots", layer: "shoes", block: 1, label: "Brown boots" },
  { id: "red-boots", layer: "shoes", block: 2, label: "Red boots" },
  { id: "grey-boots", layer: "shoes", block: 3, label: "Grey boots" },
  { id: "white-tunic", layer: "clothes", block: 0, label: "White tunic" },
  { id: "brown-tunic", layer: "clothes", block: 1, label: "Brown tunic" },
  { id: "green-tunic", layer: "clothes", block: 2, label: "Green tunic" },
  { id: "blue-tunic", layer: "clothes", block: 3, label: "Blue tunic" },
  { id: "grey-tunic", layer: "clothes", block: 4, label: "Grey tunic" },
  { id: "brown-robe", layer: "clothes", block: 5, label: "Brown robe" },
  { id: "purple-robe", layer: "clothes", block: 6, label: "Purple robe" },
  { id: "green-top-tan-trousers", layer: "clothes", block: 7, label: "Green top, tan trousers" },
  {
    id: "white-shirt-blue-trousers",
    layer: "clothes",
    block: 8,
    label: "White shirt, blue trousers",
  },
  { id: "red-top-grey-trousers", layer: "clothes", block: 9, label: "Red top, grey trousers" },
  { id: "tan-top-green-trousers", layer: "clothes", block: 10, label: "Tan top, green trousers" },
  { id: "steel-mail", layer: "clothes", block: 11, label: "Steel mail" },
  { id: "short-hair", layer: "head", block: 0, label: "Short hair" },
  { id: "beard", layer: "head", block: 1, label: "Beard" },
  { id: "long-hair", layer: "head", block: 2, label: "Long hair" },
  { id: "bald", layer: "head", block: 3, label: "Bald" },
  { id: "bald-beard", layer: "head", block: 4, label: "Bald with beard" },
  { id: "leather-cap", layer: "hat", block: 0, label: "Leather cap" },
  { id: "iron-helmet", layer: "hat", block: 1, label: "Iron helmet" },
  { id: "robin-hood-hat", layer: "hat", block: 2, label: "Robin Hood hat" },
] as const satisfies readonly { id: string; layer: LayerId; block: number; label: string }[];

type PartDef = (typeof HUMAN_PARTS)[number];

export type HumanPartId = PartDef["id"];
export type PartOn<L extends LayerId> = Extract<PartDef, { layer: L }>["id"];

export function partsOn<L extends LayerId>(layer: L): Extract<PartDef, { layer: L }>[] {
  return HUMAN_PARTS.filter((p): p is Extract<PartDef, { layer: L }> => p.layer === layer);
}

export function humanPart(id: HumanPartId): PartDef {
  return HUMAN_PARTS.find((p) => p.id === id)!;
}

/** TypeScript cannot narrow `Extract<…>["id"]` for a generic layer, so the cast lives here once. */
export function idsOn<L extends LayerId>(layer: L): PartOn<L>[] {
  return partsOn(layer).map((p) => p.id) as PartOn<L>[];
}

export function partOnSchema<L extends LayerId>(layer: L) {
  return v.picklist(idsOn(layer) as [PartOn<L>, ...PartOn<L>[]]);
}

/** The worn layer each equipment slot dresses; the other slots draw nothing on a human. */
export const LAYER_FOR_SLOT = {
  head: "hat",
  armor: "clothes",
  footwear: "shoes",
} as const satisfies Partial<Record<EquipSlot, LayerId>>;

export type WornLayer = (typeof LAYER_FOR_SLOT)[keyof typeof LAYER_FOR_SLOT];

export function layerForSlot(slot: EquipSlot): WornLayer | null {
  return (LAYER_FOR_SLOT as Partial<Record<EquipSlot, WornLayer>>)[slot] ?? null;
}

/**
 * The part a piece of armour is drawn as when worn, or null when it has none,
 * names a part nobody drew, or names one on another layer than its slot
 * dresses. A loose string on the item, so a bad name never stops the armour
 * itself loading.
 */
export function wornPartOf(armor: ArmorItem): { layer: WornLayer; id: HumanPartId } | null {
  const layer = layerForSlot(armorSlotOf(armor));
  if (!layer || !armor.humanPart) return null;
  const part = HUMAN_PARTS.find((p) => p.id === armor.humanPart && p.layer === layer);
  return part ? { layer, id: part.id } : null;
}
