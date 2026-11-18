import * as v from "valibot";
import { armorSlotOf, type ArmorItem, type ItemDef } from "./item";
import type { EquipSlot } from "./kit";

export type Recolouring = "skin" | "hair";

/**
 * The layers of a human, bottom to top, and the file each one's parts are
 * drawn in. `parts` is the `layer` its parts are listed under in
 * `HUMAN_PARTS`: the two hands hold the same things from the same file. A
 * hand is not painted in this order: `composeSheet` lays its part behind or
 * in front of the whole figure, as `HELD_PLACEMENT` says for the facing.
 */
export const LAYERS = [
  {
    id: "base",
    parts: "base",
    label: "Body",
    file: "human_base.png",
    optional: false,
    recolour: ["skin"],
  },
  {
    id: "shoes",
    parts: "shoes",
    label: "Shoes",
    file: "human_shoes.png",
    optional: true,
    recolour: [],
  },
  {
    id: "clothes",
    parts: "clothes",
    label: "Clothes",
    file: "human_clothes.png",
    optional: true,
    recolour: [],
  },
  {
    id: "head",
    parts: "head",
    label: "Head",
    file: "human_heads.png",
    optional: false,
    recolour: ["skin", "hair"],
  },
  { id: "hat", parts: "hat", label: "Hat", file: "human_hats.png", optional: true, recolour: [] },
  {
    id: "weaponHand",
    parts: "held",
    label: "Weapon hand",
    file: "human_held.png",
    optional: true,
    recolour: [],
  },
  {
    id: "offHand",
    parts: "held",
    label: "Off hand",
    file: "human_held.png",
    optional: true,
    recolour: [],
  },
] as const satisfies readonly {
  id: string;
  parts: string;
  label: string;
  file: string;
  optional: boolean;
  recolour: readonly Recolouring[];
}[];

type Layer = (typeof LAYERS)[number];

export type LayerId = Layer["id"];
export type PartGroup = Layer["parts"];
type GroupOf<L extends LayerId> = Extract<Layer, { id: L }>["parts"];

export function groupOf<L extends LayerId>(layer: L): GroupOf<L> {
  return LAYERS.find((l) => l.id === layer)!.parts as GroupOf<L>;
}

/**
 * Every drawn part, by a name that tiles, items and characters can store.
 * `block` counts the 48×64 blocks of the layer's file left to right, top to
 * bottom, blank ones included, so a block is never renumbered by adding
 * another. Retire a part by blanking its block and dropping its entry; never
 * move a block.
 */
export const HUMAN_PARTS = [
  { id: "body", layer: "base", block: 0, label: "Body" },
  { id: "bones", layer: "base", block: 1, label: "Bones" },
  { id: "dark-boots", layer: "shoes", block: 0, label: "Dark boots" },
  { id: "brown-boots", layer: "shoes", block: 1, label: "Brown boots" },
  { id: "red-boots", layer: "shoes", block: 2, label: "Red boots" },
  { id: "grey-boots", layer: "shoes", block: 3, label: "Grey boots" },
  { id: "wolfskin-boots", layer: "shoes", block: 4, label: "Wolfskin boots" },
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
  { id: "wolfskin-coat", layer: "clothes", block: 12, label: "Wolfskin coat" },
  { id: "bone-cuirass", layer: "clothes", block: 13, label: "Bone cuirass" },
  { id: "short-hair", layer: "head", block: 0, label: "Short hair" },
  { id: "beard", layer: "head", block: 1, label: "Beard" },
  { id: "long-hair", layer: "head", block: 2, label: "Long hair" },
  { id: "bald", layer: "head", block: 3, label: "Bald" },
  { id: "bald-beard", layer: "head", block: 4, label: "Bald with beard" },
  { id: "skull", layer: "head", block: 5, label: "Skull" },
  { id: "leather-cap", layer: "hat", block: 0, label: "Leather cap" },
  { id: "iron-helmet", layer: "hat", block: 1, label: "Iron helmet" },
  { id: "robin-hood-hat", layer: "hat", block: 2, label: "Robin Hood hat" },
  { id: "wolfskin-hood", layer: "hat", block: 3, label: "Wolfskin hood" },
  { id: "bone-helm", layer: "hat", block: 4, label: "Bone helm" },
  { id: "sword", layer: "held", block: 0, label: "Sword" },
  { id: "axe", layer: "held", block: 1, label: "Axe" },
  { id: "mace", layer: "held", block: 2, label: "Mace" },
  { id: "bow", layer: "held", block: 3, label: "Bow" },
  { id: "staff", layer: "held", block: 4, label: "Staff" },
  { id: "wooden-shield", layer: "held", block: 5, label: "Wooden shield" },
  { id: "metal-shield", layer: "held", block: 6, label: "Metal shield" },
] as const satisfies readonly { id: string; layer: PartGroup; block: number; label: string }[];

type PartDef = (typeof HUMAN_PARTS)[number];

export type HumanPartId = PartDef["id"];
export type PartOn<L extends LayerId> = Extract<PartDef, { layer: GroupOf<L> }>["id"];
export type HeldPartId = Extract<PartDef, { layer: "held" }>["id"];

export function partsOn<L extends LayerId>(layer: L): Extract<PartDef, { layer: GroupOf<L> }>[] {
  const group: PartGroup = groupOf(layer);
  return HUMAN_PARTS.filter((p): p is Extract<PartDef, { layer: GroupOf<L> }> => p.layer === group);
}

export function humanPart(id: HumanPartId): PartDef {
  return HUMAN_PARTS.find((p) => p.id === id)!;
}

const CREATURE_PARTS: ReadonlySet<HumanPartId> = new Set(["bones", "skull"]);

/** A part only a creature tile is drawn with: never offered to a player making a character, and never in a random look. */
export function isCreaturePart(id: HumanPartId): boolean {
  return CREATURE_PARTS.has(id);
}

/** The heads a player may choose. */
export function playerHeads(): PartOn<"head">[] {
  return idsOn("head").filter((id) => !isCreaturePart(id));
}

/** TypeScript cannot narrow `Extract<…>["id"]` for a generic layer, so the cast lives here once. */
export function idsOn<L extends LayerId>(layer: L): PartOn<L>[] {
  return partsOn(layer).map((p) => p.id) as PartOn<L>[];
}

export function partOnSchema<L extends LayerId>(layer: L) {
  return v.picklist(idsOn(layer) as [PartOn<L>, ...PartOn<L>[]]);
}

/** The layer each equipment slot dresses; the other slots draw nothing on a human. */
export const LAYER_FOR_SLOT = {
  head: "hat",
  armor: "clothes",
  footwear: "shoes",
  weapon: "weaponHand",
  offhand: "offHand",
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
export function wornPartOf(armor: ArmorItem): WornPart | null {
  const layer = layerForSlot(armorSlotOf(armor));
  if (!layer || !armor.humanPart) return null;
  const part = HUMAN_PARTS.find((p) => p.id === armor.humanPart && p.layer === layer);
  return part ? ({ layer, id: part.id } as WornPart) : null;
}

/**
 * The part a weapon or shield is drawn as in the hand that
 * holds it, or null when it names none or one that is not held. The same
 * part is drawn in either hand, so the hand is not asked.
 */
export function heldPartOf(item: ItemDef): HeldPartId | null {
  if (item.type !== "weapon" && item.type !== "shield") return null;
  const part = HUMAN_PARTS.find((p) => p.id === item.humanPart && p.layer === "held");
  return part ? (part.id as HeldPartId) : null;
}

/** A worn layer with a part from that layer; the cast in `wornPartOf` is checked by its `find`. */
export type WornPart = { [L in WornLayer]: { layer: L; id: PartOn<L> } }[WornLayer];
