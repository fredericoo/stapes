import { pileMax } from "./item";
import { getStack, replaceStack } from "./mapData";
import type { MapFile, PlacedTile, TileDef } from "./types";

const PILE_FIELDS: ReadonlySet<string> = new Set(["tileId", "itemId", "id", "count"]);

type Pile = { tileId: string; count?: number };

export function countOf(thing: Pile): number {
  return thing.count ?? 1;
}

export function withCount<T extends Pile>(thing: T, count: number): T {
  if (count > 1) return { ...thing, count };
  const { count: _dropped, ...rest } = thing;
  return rest as T;
}

export function pileTally(thing: Pile): string | null {
  const count = countOf(thing);
  return count > 1 ? `\u00d7${count}` : null;
}

function plain(thing: Pile): boolean {
  return Object.entries(thing).every(([key, value]) => value == null || PILE_FIELDS.has(key));
}

export function fuses(into: Pile, incoming: Pile, tilesById: Record<string, TileDef>): boolean {
  if (into.tileId !== incoming.tileId) return false;
  const def = tilesById[into.tileId];
  if (!def) return false;
  if (countOf(into) + countOf(incoming) > pileMax(def)) return false;
  return plain(into) && plain(incoming);
}

export function pourInto<T extends Pile>(
  list: readonly T[],
  incoming: Pile,
  tilesById: Record<string, TileDef>,
): T[] | null {
  const index = list.findIndex((held) => fuses(held, incoming, tilesById));
  if (index === -1) return null;
  return list.map((held, i) =>
    i === index ? withCount(held, countOf(held) + countOf(incoming)) : held,
  );
}

export function stow<T extends Pile>(
  list: readonly T[],
  incoming: T,
  capacity: number,
  tilesById: Record<string, TileDef>,
): T[] | null {
  const poured = pourInto(list, incoming, tilesById);
  if (poured) return poured;
  return list.length < capacity ? [...list, incoming] : null;
}

/**
 * Fills the piles of its kind already in `list`, in order, then puts what is
 * left in a free square. Null when none of it lands; otherwise `landed` says
 * how many did, and the rest stays wherever it came from.
 */
export function stowFilling<T extends Pile>(
  list: readonly T[],
  incoming: T,
  capacity: number,
  tilesById: Record<string, TileDef>,
): { list: T[]; landed: number } | null {
  const out = [...list];
  const one = withCount(incoming, 1);
  let left = countOf(incoming);
  for (let i = 0; i < out.length && left > 0; i++) {
    const into = out[i]!;
    if (!fuses(into, one, tilesById)) continue;
    const poured = Math.min(left, pileMax(tilesById[into.tileId]!) - countOf(into));
    out[i] = withCount(into, countOf(into) + poured);
    left -= poured;
  }
  if (left > 0 && out.length < capacity) {
    out.push(withCount(incoming, left));
    left = 0;
  }
  const landed = countOf(incoming) - left;
  return landed > 0 ? { list: out, landed } : null;
}

export function stowFits(
  list: readonly Pile[],
  incoming: Pile,
  capacity: number,
  tilesById: Record<string, TileDef>,
): boolean {
  if (pourInto(list, incoming, tilesById)) return true;
  return list.length < capacity;
}

export function peelOne<T extends Pile>(thing: T): T | null {
  const left = countOf(thing) - 1;
  return left <= 0 ? null : withCount(thing, left);
}

/** Bodies stand on whatever lands in their cell, so a new item goes beneath any at the top. */
export function landingIndex(stack: readonly PlacedTile[]): number {
  let i = stack.length;
  while (i > 0 && stack[i - 1]!.owner) i--;
  return i;
}

export function stackWithLanding(stack: readonly PlacedTile[], placed: PlacedTile): PlacedTile[] {
  const at = landingIndex(stack);
  return [...stack.slice(0, at), placed, ...stack.slice(at)];
}

export function stackWithItem(
  stack: readonly PlacedTile[],
  placed: PlacedTile,
  tilesById: Record<string, TileDef>,
): PlacedTile[] {
  return pourInto(stack, placed, tilesById) ?? stackWithLanding(stack, placed);
}

export function appendItem(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  placed: PlacedTile,
  tilesById: Record<string, TileDef>,
): MapFile {
  const stack = getStack(map, x, y, z);
  return replaceStack(map, x, y, z, stackWithItem(stack, placed, tilesById));
}

export function canSplit(thing: Pile, count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count < countOf(thing);
}
