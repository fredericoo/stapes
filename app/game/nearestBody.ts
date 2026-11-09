import type { ChunkCells, Coord } from "../lib/types";

export interface Located {
  readonly x: number;
  readonly y: number;
  readonly tileId: string;
  readonly levelKey: string;
  readonly chunkKey: string;
  readonly chunk: ChunkCells | undefined;
}

export interface BodyBoard {
  chunkAt(levelKey: string, chunkKey: string): ChunkCells | undefined;
  /** How many times `chunk` has been written without being replaced; see `MapDraft`. */
  writesInPlace(chunk: ChunkCells | undefined): number;
  locate(id: string): Located | null;
}

interface Nearest {
  readonly id: string;
  readonly steps: number;
  readonly order: number;
}

/** One chunk as it was when a body was found in it, compared once per version of the board. */
class ChunkSeen {
  checkedOn: unknown = null;
  unchanged = true;

  constructor(
    readonly levelKey: string,
    readonly chunkKey: string,
    readonly chunk: ChunkCells | undefined,
    readonly writes: number,
  ) {}
}

interface Entry {
  readonly id: string;
  readonly order: number;
  x: number;
  y: number;
  onTile: boolean;
  seen: ChunkSeen | null;
}

/**
 * Where every body listed for one tile stands, kept sorted by x and carried
 * from one version of the board to the next. A body is located again only
 * when the chunk it was found in has been replaced or written in place: a
 * chunk that is neither means nobody arrived in it or left it, which
 * `GameSession.tryLocate` already relies on. A body that could not be found,
 * or stands on another tile, stays listed and is looked for again on the next
 * version.
 */
export class TileColumns {
  private version: unknown = null;
  private sorted = false;

  private constructor(
    private readonly tileId: string,
    private readonly entries: Entry[],
  ) {}

  static listing(tileId: string, ids: readonly string[]): TileColumns {
    return new TileColumns(
      tileId,
      ids.map((id, order) => unlocated(id, order)),
    );
  }

  /**
   * The same tile listed again by a rebuilt index, which happens on every
   * spawn. Bodies still listed keep where they were found, under their new
   * order, so only the newcomers are located and sorted in.
   */
  relisted(ids: readonly string[]): TileColumns {
    const orderOf = new Map(ids.map((id, order) => [id, order]));
    const entries: Entry[] = [];
    for (const entry of this.entries) {
      const order = orderOf.get(entry.id);
      if (order === undefined) continue;
      orderOf.delete(entry.id);
      entries.push({ ...entry, order });
    }
    for (const [id, order] of orderOf) entries.push(unlocated(id, order));
    const next = new TileColumns(this.tileId, entries);
    next.sorted = this.sorted;
    return next;
  }

  refresh(version: unknown, board: BodyBoard) {
    if (version === this.version) return;
    this.version = version;
    const seenNow = new Map<string, ChunkSeen>();
    let moved = false;
    for (const entry of this.entries) {
      if (stillThere(entry.seen, version, board)) continue;
      this.relocate(entry, board, seenNow);
      moved = true;
    }
    if (!moved) return;
    /**
     * An insertion sort is close to one pass once the list is sorted and a
     * few bodies have moved a cell, and quadratic on a list in index order.
     */
    if (this.sorted) sortByColumn(this.entries);
    else this.entries.sort((a, b) => a.x - b.x);
    this.sorted = true;
  }

  /**
   * The fewest plan steps from `from` to a body on this tile, a tie going to
   * the body listed first, so the answer is the one a pass in list order
   * keeping only strict improvements would give. It walks outward from
   * `from.x` and stops on a side once the column distance alone exceeds the
   * best, which is why `accept` is asked only of a body that would win.
   */
  nearest(from: Coord, best: Nearest | null, accept: (id: string) => boolean): Nearest | null {
    const entries = this.entries;
    let right = firstAtOrRightOf(entries, from.x);
    let left = right - 1;
    while (left >= 0 || right < entries.length) {
      const leftDx = left >= 0 ? from.x - entries[left]!.x : Infinity;
      const rightDx = right < entries.length ? entries[right]!.x - from.x : Infinity;
      const takeLeft = leftDx <= rightDx;
      const dx = takeLeft ? leftDx : rightDx;
      if (best !== null && dx > best.steps) break;
      const entry = takeLeft ? entries[left--]! : entries[right++]!;
      if (!entry.onTile) continue;
      const steps = dx + Math.abs(entry.y - from.y);
      if (!beats(steps, entry.order, best) || !accept(entry.id)) continue;
      best = { id: entry.id, steps, order: entry.order };
    }
    return best;
  }

  private relocate(entry: Entry, board: BodyBoard, seenNow: Map<string, ChunkSeen>) {
    const loc = board.locate(entry.id);
    if (!loc) {
      entry.onTile = false;
      entry.seen = null;
      return;
    }
    entry.x = loc.x;
    entry.y = loc.y;
    entry.onTile = loc.tileId === this.tileId;
    const key = `${loc.levelKey}|${loc.chunkKey}`;
    let seen = seenNow.get(key);
    if (!seen) {
      seen = new ChunkSeen(loc.levelKey, loc.chunkKey, loc.chunk, board.writesInPlace(loc.chunk));
      seenNow.set(key, seen);
    }
    entry.seen = seen;
  }
}

function stillThere(seen: ChunkSeen | null, version: unknown, board: BodyBoard): boolean {
  if (!seen) return false;
  if (seen.checkedOn !== version) {
    seen.checkedOn = version;
    seen.unchanged =
      board.chunkAt(seen.levelKey, seen.chunkKey) === seen.chunk &&
      board.writesInPlace(seen.chunk) === seen.writes;
  }
  return seen.unchanged;
}

function unlocated(id: string, order: number): Entry {
  return { id, order, x: 0, y: 0, onTile: false, seen: null };
}

function sortByColumn(entries: Entry[]) {
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    let j = i - 1;
    while (j >= 0 && entries[j]!.x > entry.x) {
      entries[j + 1] = entries[j]!;
      j--;
    }
    entries[j + 1] = entry;
  }
}

function firstAtOrRightOf(entries: readonly Entry[], x: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid]!.x < x) low = mid + 1;
    else high = mid;
  }
  return low;
}

function beats(steps: number, order: number, best: Nearest | null): boolean {
  if (best === null) return true;
  return steps < best.steps || (steps === best.steps && order < best.order);
}

/**
 * The nearest body on any of `tileIds`, as a pass over each tile's bodies in
 * turn would find it. A tie with a body on an earlier tile id goes to that
 * body, so the best so far is carried into the next tile with an order no
 * candidate can undercut.
 */
export function nearestOnTiles(
  tileIds: readonly string[],
  columnsOf: (tileId: string) => TileColumns,
  from: Coord,
  accept: (id: string) => boolean,
): string | null {
  let best: Nearest | null = null;
  for (const tileId of tileIds) {
    if (best) best = { ...best, order: -1 };
    best = columnsOf(tileId).nearest(from, best, accept);
  }
  return best?.id ?? null;
}
