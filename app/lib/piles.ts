import { pileMax } from "./item";
import { getStack, replaceStack } from "./mapData";
import type { MapFile, PlacedTile, TileDef } from "./types";

/**
 * Several of one thing, counted rather than listed.
 *
 * ## A pile is one thing that happens to be twelve
 *
 * There is no pile type here and no container to open. A pile is an
 * {@link ItemInstance} or a {@link PlacedTile} with a `count` on it, which is
 * why every rule already written about carrying, dropping, rotting and looting
 * one berry applies unchanged to twelve — the slot rules do not know, the wire
 * does not know, and gravity does not know. What this module owns is the small
 * amount of arithmetic that *is* new: how many, where a new one goes, and when
 * two become one.
 *
 * The cost of counting rather than listing is that the twelve are
 * interchangeable and cannot be told apart afterwards. That is the reason only
 * food and a counted artifact pile — see `./item`'s `pileMax`, which is the
 * one place that is decided.
 *
 * ## One rule, in one direction
 *
 * A pile arriving somewhere pours into **the first pile of its kind with room
 * for all of it**, and otherwise takes a square of its own. It never splits
 * across two piles and never half-lands, because there is no interface for
 * choosing an amount: a move that could only partly happen would be the game
 * silently deciding a number the player was never offered. So a move either
 * happens whole or is refused, exactly as every other move in the game is.
 *
 * Nothing here reads a slot rule or a reach. Whether a thing may be somewhere at
 * all is `../game/itemMoves`' question, asked before these are.
 */

/**
 * Fields a pile may carry and still be indistinguishable from another.
 *
 * **An allow-list rather than a list of what would be lost**, and the direction
 * is the whole point: a field added to `PlacedTile` or `ItemInstance` later —
 * wear, an enchantment, whoever cooked it — makes two things stop fusing, which
 * is a pile that does not form. The other direction would make them fuse anyway
 * and quietly throw the new field away on one of them.
 *
 * `id` and `itemId` are in here because fusing is precisely the act of losing
 * one of two identities: the pile that receives keeps its own.
 */
const PILE_FIELDS: ReadonlySet<string> = new Set([
  "tileId",
  "itemId",
  "id",
  "count",
]);

/** Anything with a `count`, which is both shapes a pile is ever written in. */
type Pile = { tileId: string; count?: number };

/** How many things this is. Absent means the one thing it looks like. */
export function countOf(thing: Pile): number {
  return thing.count ?? 1;
}

/**
 * The same thing, counted differently — with the count dropped when it is one.
 *
 * Dropped rather than written, so a pile eaten down to its last berry
 * serializes as the plain berry it now is. Otherwise `count: 1` would spread
 * through `data/map.json` the first time anybody stashed anything, and every one
 * of them would mean what an absent key already means.
 */
export function withCount<T extends Pile>(thing: T, count: number): T {
  if (count > 1) return { ...thing, count };
  const { count: _dropped, ...rest } = thing;
  return rest as T;
}

/**
 * How many of it, in the two words a reader gets — or nothing for a single
 * thing.
 *
 * **One phrasing, in one place**, because three surfaces say it: the square in
 * your bag, that square read aloud, and the label over a pile lying in the
 * world. A slot that wrote "3x" while the world wrote "(3)" would be two names
 * for one fact in a game whose whole interface is about knowing what you are
 * carrying.
 *
 * Null rather than "×1" for a single thing, which is what keeps every item that
 * has never been in a pile reading exactly as it did before piles existed.
 */
export function pileTally(thing: Pile): string | null {
  const count = countOf(thing);
  // The multiplication sign rather than the letter, which is what a count beside
  // a name has always been set in.
  return count > 1 ? `\u00d7${count}` : null;
}

/** Nothing on this but what a pile may carry. See {@link PILE_FIELDS}. */
function plain(thing: Pile): boolean {
  return Object.entries(thing).every(
    ([key, value]) => value == null || PILE_FIELDS.has(key),
  );
}

/**
 * Would all of `incoming` go into `into`, leaving one pile?
 *
 * All of it or none, per the module note. Both sides must be plain, which is
 * what stops a described berry — somebody wrote on that one — from being
 * absorbed into a heap and losing what it said.
 */
export function fuses(
  into: Pile,
  incoming: Pile,
  tilesById: Record<string, TileDef>,
): boolean {
  if (into.tileId !== incoming.tileId) return false;
  const def = tilesById[into.tileId];
  if (!def) return false;
  // The ceiling before the field walk, and the order is deliberate: this is
  // asked of every stack an item lands or falls into, and nearly all of those
  // are two of something that does not pile at all — two crates in a column.
  // `pileMax` answers those with a memoised resolve and an integer compare,
  // where `plain` walks and allocates.
  if (countOf(into) + countOf(incoming) > pileMax(def)) return false;
  return plain(into) && plain(incoming);
}

/**
 * `list` with `incoming` poured into the first pile that will take all of it, or
 * null when none will.
 *
 * Null rather than an unchanged list, because the caller's next move depends on
 * which happened: a container falls back to a free square, a cell falls back to
 * a new placement, and a body square has no fallback at all.
 */
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

/**
 * A container's contents with `incoming` in them, or null when it will not fit.
 *
 * Pouring first and a free square second, which is the order that makes a pile
 * worth having: a bag with a berry in it and no empty square still takes a
 * berry, and that is the whole of "piles fuse automatically if there is room in
 * one of them".
 */
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

/** Is there anywhere in here for this, poured or in a square of its own? */
export function stowFits(
  list: readonly Pile[],
  incoming: Pile,
  capacity: number,
  tilesById: Record<string, TileDef>,
): boolean {
  if (pourInto(list, incoming, tilesById)) return true;
  return list.length < capacity;
}

/**
 * One taken off a pile, or null when that was the last of it.
 *
 * What eating one berry out of twelve does, and what a recipe spending one does.
 * Null is the caller's cue to empty the slot rather than write a pile of none —
 * see {@link ItemInstance.count}, which may not be zero.
 */
export function peelOne<T extends Pile>(thing: T): T | null {
  const left = countOf(thing) - 1;
  return left <= 0 ? null : withCount(thing, left);
}

/**
 * A cell's stack with this placement on it, poured into a pile already there
 * where one will take it.
 *
 * **The one way an item reaches a cell**, which is what makes "two berries on a
 * tile are two berries in the same tile" a fact about the board rather than
 * about the particular verb that put them there: a drop, a body dying and a pile
 * falling down a hole all land through here.
 *
 * A pile poured into is left where it is in the stack rather than raised to the
 * top. It gains no height — nothing is standing on anything — so there is
 * nothing for it to be on top *of*, and moving it would reorder a stack for a
 * change that has no picture.
 */
export function stackWithItem(
  stack: readonly PlacedTile[],
  placed: PlacedTile,
  tilesById: Record<string, TileDef>,
): PlacedTile[] {
  return pourInto(stack, placed, tilesById) ?? [...stack, placed];
}

/** {@link stackWithItem}, written back. @see appendTile, which does not pour. */
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
