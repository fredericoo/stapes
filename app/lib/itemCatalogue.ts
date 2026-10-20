import { catalogueCard, type ItemCard } from "../game/itemCard";
import type { Element } from "./element";
import { resolveItem, type ItemDef, type ItemType } from "./item";
import { itemSources, type ItemSources } from "./itemSources";
import { spellElements } from "./mastery";
import type { StatusDef } from "./status";
import type { TileDef } from "./types";

export type ItemCategory = "all" | ItemType;

export const ITEM_CATEGORIES: { value: ItemCategory; label: string }[] = [
  { value: "all", label: "All" },
  { value: "weapon", label: "Weapons" },
  { value: "shield", label: "Shields" },
  { value: "armor", label: "Armour" },
  { value: "charm", label: "Charms" },
  { value: "stone", label: "Arcane stones" },
  { value: "consumable", label: "Consumables" },
  { value: "container", label: "Bags" },
  { value: "artifact", label: "Objects" },
];

export type ItemOrigin = "any" | "shop" | "craft" | "gather" | "drop";

export const ITEM_ORIGINS: { value: ItemOrigin; label: string }[] = [
  { value: "any", label: "Anywhere" },
  { value: "shop", label: "Bought" },
  { value: "craft", label: "Crafted" },
  { value: "gather", label: "Gathered" },
  { value: "drop", label: "Dropped" },
];

export type ItemElement = "any" | Element;

export type CatalogueEntry = {
  tile: TileDef;
  type: ItemType;
  card: ItemCard;
  elements: Element[];
  sources: ItemSources;
  origins: ReadonlySet<ItemOrigin>;
  haystack: string;
};

export type CatalogueQuery = {
  text: string;
  category: ItemCategory;
  element: ItemElement;
  origin: ItemOrigin;
};

export const EMPTY_QUERY: CatalogueQuery = {
  text: "",
  category: "all",
  element: "any",
  origin: "any",
};

/**
 * Every item tile in catalogue order. The search text is the card's spoken
 * form, which already names the kind, elements, requirements and effects, plus
 * the name of every shop, station and creature it comes from or goes into.
 */
export function catalogueEntries(
  tiles: readonly TileDef[],
  statusDefs: Record<string, StatusDef>,
  playerTileId: string,
): CatalogueEntry[] {
  const names = new Map(tiles.map((tile) => [tile.id, tile.name || tile.id]));
  const sources = itemSources(tiles, playerTileId);
  const entries: CatalogueEntry[] = [];
  for (const tile of tiles) {
    const item = resolveItem(tile);
    const card = catalogueCard(tile, statusDefs);
    const found = sources.get(tile.id);
    if (!item || !card || !found) continue;
    const related = [
      ...found.finds.map((find) => find.from),
      ...[...found.obtained, ...found.usedIn].map((exchange) => exchange.at),
    ];
    const elements = elementsOf(item, card);
    entries.push({
      tile,
      type: item.type,
      card,
      elements,
      sources: found,
      origins: originsOf(found),
      haystack: [tile.id, card.speech, ...elements, ...related.map((id) => names.get(id) ?? id)]
        .join(" ")
        .toLowerCase(),
    });
  }
  return entries;
}

/** A stone's element is the one its requirements ask for, as casting reads it. */
function elementsOf(item: ItemDef, card: ItemCard): Element[] {
  if (item.type !== "stone") return card.elements;
  return [...new Set([...card.elements, ...spellElements(item.requirements)])];
}

function originsOf(sources: ItemSources): Set<ItemOrigin> {
  const origins = new Set<ItemOrigin>();
  for (const exchange of sources.obtained) {
    origins.add(exchange.kind === "trade" ? "shop" : "craft");
  }
  for (const find of sources.finds) {
    if (find.kind === "gather" || find.kind === "drop") origins.add(find.kind);
  }
  return origins;
}

export function matchesQuery(entry: CatalogueEntry, query: CatalogueQuery): boolean {
  if (query.category !== "all" && entry.type !== query.category) return false;
  if (query.element !== "any" && !entry.elements.includes(query.element)) return false;
  if (query.origin !== "any" && !entry.origins.has(query.origin)) return false;
  const terms = query.text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return terms.every((term) => entry.haystack.includes(term));
}
