/**
 * What of the map a client is told about.
 *
 * A client is sent the chunks within {@link INTEREST_REACH_CELLS} of its body,
 * and **that subscription decides the whole of what it hears**: the map it
 * joins with, the chunks handed over as it walks, and every cell patch after
 * that. The world used to send all of it — the whole board on join, and every
 * cell that changed anywhere on every tick — which was right while the map was
 * a town.
 *
 * The per-tick patch was the last piece to come inside the line, and it was not
 * bandwidth that moved it. What changes on a tick is where creatures are
 * walking, which is bounded by the brain budget rather than by the map, so
 * broadcasting it cost little. What it cost was the *rule*: a client heard
 * where every body in the world was standing whatever its subscription said, so
 * narrowing the subscription bought nothing at all for what a player can find
 * out. Now one lever moves both, and anything that narrows the subscription —
 * by level, by what a hole actually shows — narrows the wire in the same edit.
 * @see `GameServer.broadcastPatch`
 *
 * **The unit is the chunk**, because that is what the map is stored in and what
 * copy-on-write gives identity to: a subscription changes when you cross a
 * boundary rather than on every step, and a chunk that comes into reach is
 * looked up rather than assembled. The counter-argument — that a chunk arrives
 * as a lump where a cell rect trickles — is real and is answered by two things
 * this has that a cell rect does not: the chunks that come into reach are
 * handed over a few per tick rather than all at once, and the socket compresses
 * (`server/index.ts`), which takes a chunk column of dense cave from tens of
 * kilobytes to a few.
 *
 * **Every level of it, always.** Scoping by level as well is tempting and is a
 * trap: you can see down a hole into the floor below, a pit drops you a level
 * without warning, and a ramp is a level change you walk up. A body has to land
 * somewhere it has been told about.
 */
import { chunkKeyAt, chunkKeyFor, getChunk, listChunkKeys } from "../lib/mapData";
import {
  LIGHT_APRON,
  LIGHT_CHUNK_SIZE,
  LIGHT_WINDOW_MARGIN,
} from "../lib/lightingChunks";
import {
  CHUNK_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  levelKey,
} from "../lib/types";
import type { FlatMapFile, MapFile, PlacedTile } from "../lib/types";
import { VIEW_CELLS } from "../lib/view";

/**
 * How far past their own cell a client's *lighting* reads the map, in cells.
 *
 * **This is the number that decides the subscription, and it is derived rather
 * than chosen.** A cell a client has not been sent is a cell its sky flood
 * reads as open air, so the boundary of what it holds seeds daylight that
 * spills inward — a cave with a lit edge, and the light moving as you walk.
 * Making the subscription smaller than this and then telling the bake to read
 * absence as solid is the other way round, and it trades a leak for the
 * opposite error: an outdoor cell near the boundary shadowed by a wall that is
 * not there.
 *
 * Every term is somebody else's constant, so widening any of them widens this
 * in the same edit rather than silently breaking it:
 *
 * - half the view, because the window is centred on the body;
 * - the level span, because `lightWindow` unions every storey onto the rect —
 *   a light on any floor can reach the cells you are looking at;
 * - `LIGHT_WINDOW_MARGIN`, the renderer's own slack around the camera;
 * - `LIGHT_CHUNK_SIZE`, because the cache bakes whole world-aligned chunks and
 *   one can begin just inside the window and extend that far past it;
 * - `LIGHT_APRON`, the map each of those bakes reads beyond itself.
 *
 * The prefetch ring is deliberately *not* in here. A chunk baked before its map
 * arrives is a cache entry, and the cells arriving is an edit that invalidates
 * it — so it costs a rebake rather than a wrong picture.
 */
export const INTEREST_REACH_CELLS =
  Math.ceil(VIEW_CELLS / 2) +
  (MAX_LEVEL - MIN_LEVEL) +
  LIGHT_WINDOW_MARGIN +
  LIGHT_CHUNK_SIZE +
  LIGHT_APRON;

/** The same reach, rounded out to whole map chunks. */
export const INTEREST_REACH_CHUNKS = Math.ceil(INTEREST_REACH_CELLS / CHUNK_SIZE);

/**
 * Chunks a client standing at `(x, y)` is owed, on every level.
 *
 * A square of chunk *columns* rather than a set per level: the chunk key is the
 * same string on every storey, so one set answers for all seventeen and a
 * subscription is a few dozen strings rather than a few hundred.
 *
 * Deliberately not a function of which way they are facing or moving. A
 * subscription that led the player would have to be un-led when they turned
 * round, and turning round is free.
 */
export function interestChunks(x: number, y: number): Set<string> {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const out = new Set<string>();
  for (let dx = -INTEREST_REACH_CHUNKS; dx <= INTEREST_REACH_CHUNKS; dx++) {
    for (let dy = -INTEREST_REACH_CHUNKS; dy <= INTEREST_REACH_CHUNKS; dy++) {
      out.add(chunkKeyAt(cx + dx, cy + dy));
    }
  }
  return out;
}

/** Is this cell one the holder of `chunks` has been sent? */
export function covers(
  chunks: ReadonlySet<string>,
  x: number,
  y: number,
): boolean {
  return chunks.has(chunkKeyFor(x, y));
}

/** Do two subscriptions name the same chunks? */
export function sameChunks(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string>,
): boolean {
  if (a === undefined || a.size !== b.size) return false;
  for (const key of b) if (!a.has(key)) return false;
  return true;
}

/** The chunks in `now` that `before` did not already cover, nearest first. */
export function chunksEntered(
  before: ReadonlySet<string> | undefined,
  now: ReadonlySet<string>,
  at: { x: number; y: number },
): string[] {
  const out: string[] = [];
  for (const key of now) {
    if (before?.has(key)) continue;
    out.push(key);
  }
  if (out.length < 2) return out;
  // Nearest first, so a budget that hands over a few per tick spends them on
  // the ground the player is walking onto rather than on a corner of the
  // square they are walking away from.
  const cx = Math.floor(at.x / CHUNK_SIZE);
  const cy = Math.floor(at.y / CHUNK_SIZE);
  const distance = (key: string) => {
    const comma = key.indexOf(",");
    const kx = Number(key.slice(0, comma));
    const ky = Number(key.slice(comma + 1));
    return Math.max(Math.abs(kx - cx), Math.abs(ky - cy));
  };
  return out.sort((a, b) => distance(a) - distance(b));
}

/**
 * The tick's changed cells, grouped by the chunk column each one sits in.
 *
 * The first half of scoping the patch. A client hears about a cell if and only
 * if it holds the ground that cell is on, and "which chunk is this in" is asked
 * once per cell here rather than once per cell per client.
 *
 * The order of the buckets is the order the cells arrived in, and it is stable
 * for the life of one tick — which is what lets {@link patchScope} name a
 * selection of them by index instead of by chunk key.
 */
export function bucketCellsByChunk<T extends { x: number; y: number }>(
  cells: readonly T[],
): Array<{ chunk: string; cells: T[] }> {
  const byChunk = new Map<string, T[]>();
  const order: string[] = [];
  for (const cell of cells) {
    const chunk = chunkKeyFor(cell.x, cell.y);
    let bucket = byChunk.get(chunk);
    if (!bucket) {
      bucket = [];
      byChunk.set(chunk, bucket);
      order.push(chunk);
    }
    bucket.push(cell);
  }
  return order.map((chunk) => ({ chunk, cells: byChunk.get(chunk)! }));
}

/**
 * Which of a tick's buckets one subscription takes, and a key that says so.
 *
 * The second half, and the reason the scoped patch does not cost a
 * serialization per player. Two clients that take the same buckets are owed
 * byte-identical cells, so they can share one `JSON.stringify` — and the number
 * of distinct answers is bounded by *what changed on the tick*, never by how
 * many people are playing. A world where three chunks moved has at most eight
 * distinct payloads whether four people are in it or four hundred.
 *
 * The key is the taken indices joined, rather than a bitmask, because a large
 * edit — somebody painting in the editor, a world being replaced — touches more
 * chunks than a machine word has bits, and a cap there would be a correctness
 * cliff hidden inside an optimisation.
 */
export function patchScope<T>(
  buckets: ReadonlyArray<{ chunk: string; cells: T[] }>,
  chunks: ReadonlySet<string> | undefined,
): { key: string; cells: T[] } {
  // No subscription on record is not the same as an empty one. It happens
  // only before a client's first `hello` has been answered, and the safe
  // reading is the one that predates scoping: send the lot. A client shown
  // ground it did not ask for draws a correct world; one denied ground it
  // holds draws a hole.
  if (!chunks) return { key: "all", cells: buckets.flatMap((b) => b.cells) };

  const taken: number[] = [];
  for (let i = 0; i < buckets.length; i++) {
    if (chunks.has(buckets[i]!.chunk)) taken.push(i);
  }
  return {
    key: taken.join(","),
    cells: taken.flatMap((i) => buckets[i]!.cells),
  };
}

/**
 * The bodies standing in some cells, by the owner each one belongs to.
 *
 * What a client has to be re-told about when ground is handed over: a body is a
 * tile in a stack, so ground arriving brings bodies with it, and everything
 * else the client keys on an actor — its bar, its statuses, its lantern — has
 * to arrive with them. @see `GameServer.streamEnteredChunks`
 */
export function ownersIn(
  cells: ReadonlyArray<{ stack: PlacedTile[] }>,
): Set<string> {
  const owners = new Set<string>();
  for (const cell of cells) {
    for (const placed of cell.stack) {
      if (placed.owner) owners.add(placed.owner);
    }
  }
  return owners;
}

/**
 * The cells of some chunks, as the patch that hands them over.
 *
 * Their current contents rather than a diff, because there is nothing on the
 * far end to diff against: these cells have been changing, unwatched, for as
 * long as this client has been connected.
 */
export function cellsOfChunks(
  map: MapFile,
  chunks: Iterable<string>,
): Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> {
  const out: Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> = [];
  for (const chunk of chunks) {
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      const cells = getChunk(map, z, chunk);
      if (!cells) continue;
      for (const key in cells) {
        const comma = key.indexOf(",");
        out.push({
          x: Number(key.slice(0, comma)),
          y: Number(key.slice(comma + 1)),
          z,
          stack: cells[key]!,
        });
      }
    }
  }
  return out;
}

/**
 * The map as one client should first see it.
 *
 * The shape is a whole `FlatMapFile` because that is what a joiner is sent and
 * what it parses — a client is not told it is holding part of a map, and has no
 * use for knowing. What it does not have, it cannot see.
 */
export function mapOfInterest(
  map: MapFile,
  chunks: ReadonlySet<string>,
): FlatMapFile {
  const levels: FlatMapFile["levels"] = {};
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    // Whichever list is shorter: a subscription is a few dozen chunks and a
    // level of the shipped map is a few dozen too, so neither is reliably the
    // cheaper one to walk.
    const present = listChunkKeys(map, z);
    const walk = present.length < chunks.size ? present : [...chunks];
    for (const chunk of walk) {
      if (!chunks.has(chunk)) continue;
      const cells = getChunk(map, z, chunk);
      if (!cells) continue;
      for (const key in cells) {
        (levels[levelKey(z)] ??= {})[key] = cells[key]!;
      }
    }
  }
  return { version: 1, levels };
}
