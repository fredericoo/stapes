import { resolveBrain } from "./brain";
import type { TileDef } from "./types";

export type TileFilterKind = "all" | "battler" | "npc" | "item";

export const TILE_FILTER_KINDS: { value: TileFilterKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "battler", label: "Battlers" },
  { value: "npc", label: "NPCs" },
  { value: "item", label: "Items" },
];

export function matchesTileFilter(def: TileDef, filter: TileFilterKind): boolean {
  if (filter === "all") return true;
  if (filter === "npc") return resolveBrain(def) !== null;
  return def.kind === filter;
}

function haystack(def: TileDef): string {
  return `${def.name} ${def.id}`.toLowerCase();
}

export function matchesTileQuery(def: TileDef, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(def);
  return terms.every((term) => text.includes(term));
}

export function filterTiles(tiles: TileDef[], query: string, filter: TileFilterKind): TileDef[] {
  return tiles.filter((tile) => matchesTileFilter(tile, filter) && matchesTileQuery(tile, query));
}
