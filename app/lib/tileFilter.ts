import { resolveBrain } from "./brain";
import type { TileDef } from "./types";

/**
 * The catalogue's filter axis, which is deliberately *not* {@link TileKind}.
 *
 * Three of the four buckets would come free off `kind`, and the fourth is the
 * reason this type exists: an NPC is not a kind, it is a tile with a brain, and
 * `resolveActor` already treats a brain as the thing that makes a body driven.
 * A creature with hit points and a brain is honestly both a battler and an NPC,
 * so the buckets overlap and a tile can answer to two of them.
 *
 * That overlap is why the control is a filter rather than a grouping: it asks
 * "show me the ones that are X", which has an answer for every tile, instead of
 * "which one is this", which does not.
 */
export type TileFilterKind = "all" | "battler" | "npc" | "item";

export const TILE_FILTER_KINDS: { value: TileFilterKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "battler", label: "Battlers" },
  { value: "npc", label: "NPCs" },
  { value: "item", label: "Items" },
];

/**
 * Does this tile belong in the named bucket?
 *
 * `npc` asks {@link resolveBrain} rather than reading `interactions.brain`
 * directly, so a brain that does not parse — a hand-edit, a half-written state
 * machine — leaves the tile out of the bucket. The world would not drive it
 * either, and a catalogue that listed it as an NPC would be describing a
 * creature that stands still.
 */
export function matchesTileFilter(def: TileDef, filter: TileFilterKind): boolean {
  if (filter === "all") return true;
  if (filter === "npc") return resolveBrain(def) !== null;
  return def.kind === filter;
}

/**
 * The words a tile answers to.
 *
 * Name and id only — the two things the card actually shows. Folding in the
 * kind or the type would make "item" match every item without the filter having
 * been touched, which reads as the search being broken rather than clever.
 */
function haystack(def: TileDef): string {
  return `${def.name} ${def.id}`.toLowerCase();
}

/**
 * Every term must appear somewhere, in any order.
 *
 * Order-independence is what makes typing forgiving: "troll cave" finds the cave
 * troll, and so does "cave troll". A single substring test over the whole query
 * would find neither unless you happened to type the name the way it was
 * authored.
 */
export function matchesTileQuery(def: TileDef, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(def);
  return terms.every((term) => text.includes(term));
}

export function filterTiles(
  tiles: TileDef[],
  query: string,
  filter: TileFilterKind,
): TileDef[] {
  return tiles.filter(
    (tile) => matchesTileFilter(tile, filter) && matchesTileQuery(tile, query),
  );
}
