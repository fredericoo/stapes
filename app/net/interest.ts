/**
 * What of the map a client is told about.
 *
 * The world is one board, and a client is sent the part of it near its own
 * body: the chunks in reach on join, the chunks that come into reach as it
 * walks, and — by the same subscription, in `./scope` — the cells that change
 * inside it. Before that it was sent all of the map and then told about every
 * cell that changed anywhere, which on the den map was 4.9MB to join and a tick
 * stream that grew with everybody else's neighbourhood rather than with the
 * player's own.
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
import { LIGHT_APRON, LIGHT_CHUNK_SIZE, LIGHT_WINDOW_MARGIN } from "../lib/lightingChunks";
import { MAX_LIGHT_LEVEL } from "../lib/types";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL, levelKey } from "../lib/types";
import { MAP_FILE_VERSION } from "../lib/types";
import type { FlatMapFile, MapFile, PlacedTile } from "../lib/types";
import { MESH_WINDOW_MARGIN, VIEW_CELLS } from "../lib/view";

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
 * How far away a *body* is worth telling a client about, in cells.
 *
 * **A body is not terrain, and it does not need the reach terrain does.** The
 * number above is the light bake's — 47 of its 79 cells are `LIGHT_CHUNK_SIZE`
 * plus `LIGHT_APRON`, the map a cached bake reads beyond the window it fills.
 * Nothing about a creature feeds that bake: every body tile is `lightPassing`,
 * so it casts no shadow, and `terrainHeight` skips a person outright. Scoping
 * bodies at the terrain reach therefore bought nothing and cost everything —
 * the subscription is a square 176 cells across, `data/map.json` is 168 wide,
 * and the brain budget keeps two dozen creatures walking somewhere on it every
 * round. A player anywhere in the world was told about all of them.
 *
 * Every term is again somebody else's constant:
 *
 * - half the view, because a body outside it is not drawn;
 * - the level span, because the projection shifts level `z` by `z` cells, so a
 *   body that many storeys up is drawn that far off its own column. Only the
 *   worst case is a constant: {@link withinBodyReach} charges the storeys
 *   actually between the two, and on the den — where a player stands in the
 *   middle of a stack of cave floors — asking for the real difference rather
 *   than the whole span is the difference between 128 bodies in reach and 89;
 * - `MESH_WINDOW_MARGIN`, the slack the renderer builds geometry with — a body
 *   is a sprite drawn from its cell upward, and a tall one a few rows below the
 *   bottom edge still paints inside the view;
 * - `MAX_LIGHT_LEVEL`, because a body can be *carrying* a lantern, and a client
 *   that has not been told there is a body has no emitter to overlay for it.
 *   This is the term that makes the reach bigger than anything that is drawn.
 *
 * **It must stay inside the terrain reach**, or a body would be announced
 * standing on ground its client has not been sent. `INTEREST_REACH_CHUNKS`
 * chunks is the *least* the subscription covers in any direction — a body at
 * the start of its own chunk holds exactly that far west — so that is what this
 * is measured against, and `interest.test.ts` pins it.
 */
/** The same reach between two bodies on one storey, before the skew below. */
export const BODY_REACH_ON_LEVEL = Math.ceil(VIEW_CELLS / 2) + MESH_WINDOW_MARGIN + MAX_LIGHT_LEVEL;

export const BODY_REACH_CELLS = BODY_REACH_ON_LEVEL + (MAX_LEVEL - MIN_LEVEL);

/**
 * Is a body at `(x, y)` close enough to a client at `at` to be worth telling
 * them about?
 *
 * A square in cells rather than the chunk square the map is scoped by, and the
 * difference is the point: rounding this out to chunks would round 49 cells up
 * to four chunk columns, which reaches 79 — the number this exists to get away
 * from. Cells are also cheaper to ask about, since there is no key to build.
 *
 * Every level, on the terms the map is — a body one storey down a hole is a
 * body you can see — but not every level equally: see below.
 */
export function withinBodyReach(
  at: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
): boolean {
  return withinBodyReachOf(at.x, at.y, at.z, x, y, z);
}

/**
 * {@link withinBodyReach}, with the viewer spelled out as three numbers.
 *
 * For the loops that ask it of every changed body and cell for every client on
 * every tick, which read positions out of typed columns and have no object to
 * hand it.
 */
export function withinBodyReachOf(
  atX: number,
  atY: number,
  atZ: number,
  x: number,
  y: number,
  z: number,
): boolean {
  // The projection's own arithmetic: a level is drawn shifted by its own
  // number, so what stands between these two is the storeys between them and
  // not the whole span the world has. @see `../render/meshWindow`
  const reach = BODY_REACH_ON_LEVEL + Math.abs(z - atZ);
  return Math.abs(x - atX) <= reach && Math.abs(y - atY) <= reach;
}

/** The side of one {@link BodyGrid} bucket, in cells. A chunk, so a bucket is one column. */
const BODY_GRID_CELLS = CHUNK_SIZE;

/** One number per bucket, for any bucket a board of this size could have. */
function bodyGridKey(bx: number, by: number): number {
  return (bx + 0x8000) * 0x10000 + (by + 0x8000);
}

/**
 * Bodies filed by the column they stand in, so that "who is within body reach
 * of this viewer" is asked of the few buckets that could hold an answer rather
 * than of every body in the world.
 *
 * **This is what a crowd costs without it.** Every client asks that question on
 * every tick, and asking it of every body makes the tick the product of the
 * two populations: a thousand players and two hundred creatures is 1.2 million
 * reach tests a tick, which on its own took 116ms of a 33ms tick. The reach is
 * a square of at most {@link BODY_REACH_CELLS} each way, so seven buckets by
 * seven cover it wherever the viewer stands, and a body outside them cannot be
 * in reach.
 *
 * Built once per tick from that tick's bodies, and read-only after that.
 * Levels are not filed apart: the reach reaches every level, and
 * {@link withinBodyReach} charges the storeys between two bodies itself.
 */
export class BodyGrid {
  private readonly buckets = new Map<number, number[]>();

  constructor(private readonly bodies: ReadonlyArray<{ x: number; y: number; z: number }>) {
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!;
      const key = bodyGridKey(
        Math.floor(body.x / BODY_GRID_CELLS),
        Math.floor(body.y / BODY_GRID_CELLS),
      );
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  /**
   * The index of every body within body reach of `at`, in no particular order.
   *
   * Exactly the bodies {@link withinBodyReach} says yes to — the buckets only
   * decide which bodies are asked.
   */
  near(at: { x: number; y: number; z: number }): number[] {
    const out: number[] = [];
    const minX = Math.floor((at.x - BODY_REACH_CELLS) / BODY_GRID_CELLS);
    const maxX = Math.floor((at.x + BODY_REACH_CELLS) / BODY_GRID_CELLS);
    const minY = Math.floor((at.y - BODY_REACH_CELLS) / BODY_GRID_CELLS);
    const maxY = Math.floor((at.y + BODY_REACH_CELLS) / BODY_GRID_CELLS);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        const bucket = this.buckets.get(bodyGridKey(bx, by));
        if (!bucket) continue;
        for (const i of bucket) {
          const body = this.bodies[i]!;
          if (withinBodyReach(at, body.x, body.y, body.z)) out.push(i);
        }
      }
    }
    return out;
  }
}

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
export function covers(chunks: ReadonlySet<string>, x: number, y: number): boolean {
  return chunks.has(chunkKeyFor(x, y));
}

/** Do two subscriptions name the same chunks? */
export function sameChunks(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean {
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
 * **A client is never sent a body it has not been told about.** Without this
 * the cheaper arrangement — stop sending a distant creature's steps, leave the
 * cells alone — puts a tile of it in the client's board for ever: the cell it
 * was standing in is never rewritten, so the body sits there unowned by any
 * actor entry. It is too far away to draw, and the board is not only drawn.
 * `fitsTile` counts a creature as solid, so the client would refuse its own
 * player a step into a cell a deer left an hour ago, and a route planned across
 * it would walk round something that is not there.
 *
 * Returns the stack itself when there is nothing to take out, which is the
 * ordinary case — a cell with no body in it at all.
 */
export function visibleStack(stack: PlacedTile[], held: ReadonlySet<string>): PlacedTile[] {
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
 * long as they have been out of reach. That is also what makes it safe to stop
 * sending a client the changes in a chunk it has walked away from — the chunk
 * is dropped from what it holds on the way out, so coming back into reach hands
 * it over whole rather than patching a board nobody kept current. @see `./scope`
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
          // Ground that has come into reach arrives with whoever is standing on
          // it taken out, unless this client already holds them. A chunk three
          // storeys down can be handed over with a rat in it, and a rat this
          // client is not being told about is a rat it would hold for ever.
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
 * The shape is a whole `FlatMapFile` because that is what a joiner is sent and
 * what it parses — a client is not told it is holding part of a map, and has no
 * use for knowing. What it does not have, it cannot see.
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
        // Without whoever is standing on it, on {@link cellsOfChunks}' terms:
        // the bodies a joiner is told about are the ones near it, and a body in
        // its board that is in neither its actor list nor anything it will hear
        // about again is a tile nothing can ever take back off.
        (levels[levelKey(z)] ??= {})[key] = visibleStack(cells[key]!, held);
      }
    }
  }
  return { version: MAP_FILE_VERSION, levels };
}
