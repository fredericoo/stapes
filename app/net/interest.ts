/**
 * What of the map a client is told about.
 *
 * The world is one board, and a client is sent the part of it near its own
 * body: the chunks in reach on join, the chunks that come into reach as it
 * walks, and — by the same subscription, in `./scope` — the cells that change
 * inside it.
 *
 * The unit is the chunk, because that is what the map is stored in and what
 * copy-on-write gives identity to: a subscription changes when you cross a
 * boundary rather than on every step, and a chunk that comes into reach is
 * looked up rather than assembled. A chunk arrives as a lump where a cell rect
 * would trickle, but chunks coming into reach are handed over a few per tick,
 * and the socket compresses (`server/index.ts`), which takes a chunk column of
 * dense cave from tens of kilobytes to a few.
 *
 * Every level, always. Scoping by level as well would break: you can see down
 * a hole into the floor below, a pit drops you a level without warning, and a
 * ramp is a level change you walk up. A body has to land somewhere it has been
 * told about.
 */
import { chunkKeyAt, chunkKeyFor, getChunk, listChunkKeys } from "../lib/mapData";
import {
  LIGHT_APRON,
  LIGHT_CHUNK_SIZE,
  LIGHT_WINDOW_MARGIN,
} from "../lib/lightingChunks";
import { MAX_LIGHT_LEVEL } from "../lib/types";
import {
  CHUNK_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  levelKey,
} from "../lib/types";
import { MAP_FILE_VERSION } from "../lib/types";
import type { FlatMapFile, MapFile, PlacedTile } from "../lib/types";
import { MESH_WINDOW_MARGIN, VIEW_CELLS } from "../lib/view";

/**
 * How far past their own cell a client's *lighting* reads the map, in cells.
 *
 * This is the number that decides the subscription, and it is derived rather
 * than chosen. A cell a client has not been sent is a cell its sky flood reads
 * as open air, so the boundary of what it holds seeds daylight that spills
 * inward: a cave with a lit edge, and the light moving as you walk. Making the
 * subscription smaller and telling the bake to read absence as solid trades
 * that leak for the opposite error: an outdoor cell near the boundary shadowed
 * by a wall that is not there.
 *
 * Every term is somebody else's constant, so widening any of them widens this
 * in the same edit:
 *
 * - half the view, because the window is centred on the body;
 * - the level span, because `lightWindow` unions every storey onto the rect —
 *   a light on any floor can reach the cells you are looking at;
 * - `LIGHT_WINDOW_MARGIN`, the renderer's own slack around the camera;
 * - `LIGHT_CHUNK_SIZE`, because the cache bakes whole world-aligned chunks and
 *   one can begin just inside the window and extend that far past it;
 * - `LIGHT_APRON`, the map each of those bakes reads beyond itself.
 *
 * The prefetch ring is not in here. A chunk baked before its map arrives is a
 * cache entry, and the cells arriving is an edit that invalidates it, so it
 * costs a rebake rather than a wrong picture.
 */
export const INTEREST_REACH_CELLS =
  Math.ceil(VIEW_CELLS / 2) +
  (MAX_LEVEL - MIN_LEVEL) +
  LIGHT_WINDOW_MARGIN +
  LIGHT_CHUNK_SIZE +
  LIGHT_APRON;

/** The same reach, rounded out to whole map chunks. */
export const INTEREST_REACH_CHUNKS = Math.ceil(INTEREST_REACH_CELLS / CHUNK_SIZE);

/** The body reach on one storey; {@link withinBodyReach} adds the storeys between. */
export const BODY_REACH_ON_LEVEL =
  Math.ceil(VIEW_CELLS / 2) + MESH_WINDOW_MARGIN + MAX_LIGHT_LEVEL;

/**
 * How far away a *body* is worth telling a client about, in cells.
 *
 * A body does not need the reach terrain does. `INTEREST_REACH_CELLS` is the
 * light bake's: 47 of its 79 cells are `LIGHT_CHUNK_SIZE` plus `LIGHT_APRON`.
 * Nothing about a creature feeds that bake (every body tile is `lightPassing`,
 * so it casts no shadow, and `terrainHeight` skips a person), and scoping
 * bodies at the terrain reach would tell a player anywhere on a map narrower
 * than the 176-cell subscription square about every creature on it.
 *
 * Every term is somebody else's constant:
 *
 * - half the view, because a body outside it is not drawn;
 * - the level span, because the projection shifts level `z` by `z` cells, so a
 *   body that many storeys up is drawn that far off its own column. This is
 *   the worst case; {@link withinBodyReach} charges only the storeys actually
 *   between the two, which for a player in the middle of a stack of cave
 *   floors is the difference between 128 bodies in reach and 89;
 * - `MESH_WINDOW_MARGIN`, the slack the renderer builds geometry with: a body
 *   is a sprite drawn from its cell upward, and a tall one a few rows below the
 *   bottom edge still paints inside the view;
 * - `MAX_LIGHT_LEVEL`, because a body can be carrying a lantern, and a client
 *   that has not been told there is a body has no emitter to overlay for it.
 *   This is the term that makes the reach bigger than anything that is drawn.
 *
 * It must stay inside the terrain reach, or a body would be announced standing
 * on ground its client has not been sent. `INTEREST_REACH_CHUNKS` chunks is the
 * least the subscription covers in any direction (a body at the start of its
 * own chunk holds exactly that far west), so that is what this is measured
 * against, and `interest.test.ts` pins it.
 */
export const BODY_REACH_CELLS = BODY_REACH_ON_LEVEL + (MAX_LEVEL - MIN_LEVEL);

/**
 * Is a body at `(x, y, z)` close enough to a client at `at` to be worth telling
 * them about?
 *
 * A square in cells rather than the chunk square the map is scoped by: rounding
 * this out to chunks would round 49 cells up to four chunk columns, which is
 * 79, the number this exists to get away from. Cells are also cheaper to ask
 * about, since there is no key to build.
 *
 * Every level, as the map is (a body one storey down a hole is a body you can
 * see), widened only by the storeys between the two.
 */
export function withinBodyReach(
  at: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
): boolean {
  // A level is drawn shifted by its own number, so only the storeys between
  // the two count, not the whole span. @see `../render/meshWindow`
  const reach = BODY_REACH_ON_LEVEL + Math.abs(z - at.z);
  return Math.abs(x - at.x) <= reach && Math.abs(y - at.y) <= reach;
}

/**
 * Chunks a client standing at `(x, y)` is owed, on every level.
 *
 * A square of chunk columns rather than a set per level: the chunk key is the
 * same string on every storey, so one set answers for all of them and a
 * subscription is a few dozen strings rather than a few hundred.
 *
 * Not a function of which way they are facing or moving. A subscription that
 * led the player would have to be un-led when they turned round, and turning
 * round is free.
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
 * The placements of a stack that a client holding `held` is allowed to see.
 *
 * A client is never sent a body it has not been told about. Leaving a distant
 * creature's tile in the cells while not sending its steps would put that tile
 * in the client's board for ever: the cell is never rewritten, so the body sits
 * there owned by no actor entry. `fitsTile` counts a creature as solid, so the
 * client would refuse its own player a step into a cell a deer left an hour
 * ago, and a route planned across it would walk round nothing.
 *
 * Returns the stack itself when there is nothing to take out, the ordinary
 * case.
 */
export function visibleStack(
  stack: PlacedTile[],
  held: ReadonlySet<string>,
): PlacedTile[] {
  let out: PlacedTile[] | null = null;
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i]!;
    if (!placed.owner || held.has(placed.owner)) {
      out?.push(placed);
      continue;
    }
    out ??= stack.slice(0, i);
  }
  return out ?? stack;
}

/**
 * The cells of some chunks, as the patch that hands them over.
 *
 * Their current contents rather than a diff, because there is nothing on the
 * far end to diff against: these cells have been changing, unwatched, for as
 * long as they have been out of reach. That is what makes it safe to stop
 * sending a client the changes in a chunk it has walked away from: the chunk
 * is dropped from what it holds on the way out, so coming back into reach hands
 * it over whole. @see `./scope`
 */
export function cellsOfChunks(
  map: MapFile,
  chunks: Iterable<string>,
  held: ReadonlySet<string>,
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
          // Without bodies this client has not been told about: a rat handed
          // over in a chunk three storeys down would otherwise be held for ever.
          stack: visibleStack(cells[key]!, held),
        });
      }
    }
  }
  return out;
}

/**
 * The map as one client should first see it.
 *
 * A whole `FlatMapFile` because that is what a joiner is sent and parses; a
 * client is not told it is holding part of a map.
 */
export function mapOfInterest(
  map: MapFile,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
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
        // Without bodies this client has not been told about, as in
        // {@link cellsOfChunks}: nothing would ever take such a tile back off.
        (levels[levelKey(z)] ??= {})[key] = visibleStack(cells[key]!, held);
      }
    }
  }
  return { version: MAP_FILE_VERSION, levels };
}
