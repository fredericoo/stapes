/**
 * World-aligned light cache.
 *
 * The monolithic bake ({@link computeLightingFlood}) allocates six typed arrays
 * over the *dense bounding box* of the whole map, so its cost tracks the map's
 * extent rather than its content — untenable once the world is thousands of
 * tiles wide. This slices light into fixed world-space chunks, bakes only the
 * ones a caller actually asks for, and keeps them until something near them
 * changes. Cost becomes a function of the view window, not the world.
 *
 * Correctness rests on light being local: sky spread starts at
 * {@link MAX_LIGHT_LEVEL} and every lateral step costs at least 1, so nothing
 * more than that many cells away can reach a given cell. Baking a chunk with an
 * apron that wide therefore reproduces the monolithic result exactly inside the
 * chunk — see the parity test.
 */
import type {
  AnimatedEmitter,
  LightGrid,
  LevelLightMap,
  PackedLevelLight,
  PackedLightGrid,
  RawLevelLight,
} from "./lighting";
import { composeAmbientRgb } from "./lighting";
import { computeLightingFlood, MAX_LIGHT_LEVEL } from "./lightingFlood";
import type {
  ChunkCells,
  LevelChunks,
  MapFile,
  PlacedTile,
  TileDef,
} from "./types";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  maxLightRadius,
  parseCoordKey,
  physicalHeight,
  resolveLightPassing,
  tileCanEmitLight,
  tileEmissionPhase,
} from "./types";

/**
 * Chunk edge in cells. The apron is paid on every bake, so small chunks waste
 * most of their work on margin: at 16 a chunk bakes 8.3x its own area, at 32
 * it is 3.8x. Larger chunks invert the problem — a single edit then dirties a
 * bigger region. 32 is the knee, and batching (see {@link bakeRegion}) recovers
 * most of the remaining margin cost when several chunks are filled at once.
 */
export const LIGHT_CHUNK_SIZE = 32;

/**
 * Cells of map data to read beyond a chunk so its interior bakes correctly.
 *
 * A crop is exact only when it is wider than everything that can reach into it,
 * and this is that width for both of the things that can. Sky spill is seeded at
 * {@link MAX_LIGHT_LEVEL} and decays at least 1 per lateral step, which is a
 * property of the flood. Block emitters are bounded by the same number only
 * because `clampTileLight` holds them there — `LightDef.radius` is otherwise an
 * unbounded field, and an authored 25 would light its own chunk and stop dead at
 * the edge of the next, with nothing throwing and no test failing.
 *
 * **So the clamp is load-bearing, not tidiness.** If it is ever removed or
 * loosened this constant stops being a sound crop, and the fix is to move the
 * ceiling in both places at once rather than to widen the apron here: the apron
 * is charged on every bake in the world, and at 32 cells a chunk already bakes
 * 3.8x its own area to pay for it.
 */
export const LIGHT_APRON = MAX_LIGHT_LEVEL;

/**
 * Cells of slack around the camera's reach before the light window is taken.
 *
 * Here rather than in the renderer that applies it, because the server has to
 * know how far a client's bake reads: what a client is not sent, the sky flood
 * reads as open air, so the subscription has to cover everything the bake can
 * touch or daylight seeds itself at the boundary. See `app/net/interest`.
 */
export const LIGHT_WINDOW_MARGIN = 4;

export type WorldRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Chunks of margin kept baked beyond the window. One ring is enough: crossing a
 * 32-cell chunk takes the player seconds at walking pace, and the trickle below
 * fills it long before then.
 */
export const PREFETCH_RING_CHUNKS = 1;

/**
 * Chunks baked per idle call. Deliberately one, and one is already generous: a
 * single chunk bake measures ~4.7ms on the fixture map, which is most of a
 * 120fps frame on its own. Filling a whole ring in one call would simply
 * relocate the hitch this exists to remove. Spread over frames it disappears
 * into the walk — but raising this without first making a bake cheaper would
 * put the stutter straight back.
 */
export const PREFETCH_CHUNKS_PER_CALL = 1;

/**
 * Baked chunk-phases held before the coldest chunks are dropped. ~68 KiB each
 * (RGBA raw), so this caps the cache near 17 MiB. A chunk no flicker reaches
 * counts once; one a torch reaches counts once per phase of that torch's cycle.
 * Must comfortably exceed the window's chunk count or the window would evict
 * itself and rebake every frame.
 */
export const DEFAULT_MAX_CACHED_CHUNKS = 256;

/**
 * Per-chunk light: one plane per level, `LIGHT_CHUNK_SIZE` square.
 * Layout is RGBA: block R,G,B + sky factor — ambient is applied at assemble.
 */
export type ChunkLight = Map<number, Uint8Array>;

type CachedChunk = {
  /**
   * Baked light per emission phase — one lone `""` entry for the overwhelming
   * majority of chunks, which no flicker reaches.
   *
   * Holding every phase rather than the latest is the whole trick: a torch's
   * cycle is short and repeats for ever, so after one turn of it every phase is
   * baked and the flicker costs a map lookup a frame instead of a bake several
   * times a second.
   */
  byPhase: Map<string, ChunkLight>;
  /**
   * Ids of clock-driven emitters that reach this chunk, sorted and deduped.
   * Empty means the chunk's light does not depend on the clock at all.
   */
  animated: string[];
  /** Tick this chunk was last drawn from — the LRU's recency stamp. */
  usedAt: number;
  /**
   * These pixels predate an edit near them, and a refresh is wanted.
   *
   * Only ever set when there is a {@link ChunkBaker} to do that refreshing.
   * Without one there is nothing to wait for, so an edit drops the chunk
   * outright and the next call rebakes it in the frame that asked.
   */
  stale: boolean;
  /**
   * Value of the cache's dirty counter when this chunk was last invalidated.
   *
   * The whole of the race guard: a bake in flight was computed against the map
   * as it stood when it was asked for, so its result may already be out of date
   * by the time it lands. Comparing this against the counter the request
   * captured says whether anything has happened since — if it has, the pixels
   * are still an improvement and are kept, but the chunk stays stale so the
   * next call asks again.
   */
  dirtyAt: number;
};

/** One chunk's slice of a bake, plus what it will go stale with. */
export type BakedChunk = {
  planes: ChunkLight;
  animated: string[];
};

/**
 * Somewhere to send a bake that is not this thread.
 *
 * Deliberately this small. The cache does not care whether the other side is a
 * worker, a queue or a test double, only that a rect and a clock reading go in
 * and chunks come back later — which is what makes the whole async path
 * optional: with no baker the cache behaves exactly as it did when a bake was
 * a function call.
 *
 * `timeMs` travels with the rect rather than being read on arrival, because the
 * clock will have moved by then and the result is filed under the phase it was
 * baked at. Asking for "now" and filing under "now, later" would put a torch's
 * bright frame in the slot its dim one is looked up from.
 */
export type ChunkBaker = {
  bake(rect: WorldRect, timeMs: number): Promise<Map<string, BakedChunk>>;
};

/**
 * Bakes allowed in flight at once. One, because the far side is a single
 * thread: a second request would queue behind the first rather than finish any
 * sooner, and holding it here instead means it is re-formed against whatever
 * the map looks like when the first lands rather than against a stale rect.
 */
const MAX_INFLIGHT_BAKES = 1;

/** Copy a chunk's RGBA plane straight into the window plane — no per-pixel work. */
function blitPacked(
  planesByZ: Map<number, Uint8Array>,
  chunk: ChunkLight,
  ox: number,
  oy: number,
  w: number,
  h: number,
) {
  for (const [z, plane] of chunk) {
    let dstPlane = planesByZ.get(z);
    if (!dstPlane) {
      dstPlane = new Uint8Array(w * h * RAW_STRIDE);
      planesByZ.set(z, dstPlane);
    }
    for (let row = 0; row < LIGHT_CHUNK_SIZE; row++) {
      const src = row * LIGHT_CHUNK_SIZE * RAW_STRIDE;
      const dstRow = oy * LIGHT_CHUNK_SIZE + row;
      const dst = (dstRow * w + ox * LIGHT_CHUNK_SIZE) * RAW_STRIDE;
      dstPlane.set(plane.subarray(src, src + LIGHT_CHUNK_SIZE * RAW_STRIDE), dst);
    }
  }
}

/** Bytes per cell in a raw chunk plane (block RGB + sky). */
const RAW_STRIDE = 4;

function chunkOf(v: number): number {
  return Math.floor(v / LIGHT_CHUNK_SIZE);
}

function chunkCacheKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/**
 * Identity of everything an assembled grid depends on, spatially.
 *
 * Both assemble paths snap to whole chunks, so a window nudged one cell east
 * produces byte-identical output until it crosses a chunk edge. Keying on the
 * raw rect missed that and rebuilt every plane on every frame the camera moved
 * — cheap in itself, but it minted a new grid object each time, and callers use
 * grid identity to decide whether to re-upload their textures. A walk was
 * therefore re-uploading every level, every frame, to hand the GPU bytes it
 * already had.
 */
function chunkSpanKey(rect: WorldRect): string {
  return [
    chunkOf(rect.x0),
    chunkOf(rect.y0),
    chunkOf(rect.x1),
    chunkOf(rect.y1),
  ].join(",");
}

function chunkRect(cx: number, cy: number): WorldRect {
  const x0 = cx * LIGHT_CHUNK_SIZE;
  const y0 = cy * LIGHT_CHUNK_SIZE;
  return { x0, y0, x1: x0 + LIGHT_CHUNK_SIZE - 1, y1: y0 + LIGHT_CHUNK_SIZE - 1 };
}

/**
 * Prefetch priority for a candidate chunk: how far it lies in the direction the
 * window is drifting, less its distance from the centre. With no drift this
 * degrades to nearest-first, so a stationary camera still warms its ring.
 */
function prefetchScore(
  candidate: { cx: number; cy: number },
  centre: { x: number; y: number },
  drift: { x: number; y: number },
): number {
  const dx = (candidate.cx + 0.5) * LIGHT_CHUNK_SIZE - centre.x;
  const dy = (candidate.cy + 0.5) * LIGHT_CHUNK_SIZE - centre.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ahead = (dx * drift.x + dy * drift.y) / distance;
  return ahead * LIGHT_CHUNK_SIZE - distance;
}

/** Copy one chunk's square out of a baked raw level plane (block RGB + sky). */
function sliceChunk(level: RawLevelLight, rect: WorldRect): Uint8Array {
  const out = new Uint8Array(LIGHT_CHUNK_SIZE * LIGHT_CHUNK_SIZE * RAW_STRIDE);
  for (let row = 0; row < LIGHT_CHUNK_SIZE; row++) {
    const sy = rect.y0 + row - level.y0;
    if (sy < 0 || sy >= level.h) continue;
    const sx = rect.x0 - level.x0;
    const from = Math.max(0, sx);
    const to = Math.min(level.w, sx + LIGHT_CHUNK_SIZE);
    if (to <= from) continue;
    for (let x = from; x < to; x++) {
      const srcCell = sy * level.w + x;
      const dstCell = row * LIGHT_CHUNK_SIZE + (x - sx);
      const srcP = srcCell * 3;
      const dstP = dstCell * RAW_STRIDE;
      out[dstP] = level.block[srcP]!;
      out[dstP + 1] = level.block[srcP + 1]!;
      out[dstP + 2] = level.block[srcP + 2]!;
      out[dstP + 3] = level.sky[srcCell]!;
    }
  }
  return out;
}

/**
 * Furthest cell, in each axis, an emitter of this radius can actually light.
 *
 * The flood drops anything beyond the radius and attenuates the rest by
 * `1 - dist / radius`, so a cell exactly `radius` away is already black — the
 * lit set is the cells *strictly* inside the sphere. Rounding the radius up
 * instead of down is not the harmless over-estimate it looks like: for a
 * flickering emitter it charges chunks it cannot reach an extra phase axis, and
 * those chunks then rebake every time it ticks, for ever, over light that is
 * provably zero.
 */
function litReach(radius: number): number {
  return Math.max(0, Math.ceil(radius) - 1);
}

/**
 * Which chunks each clock-driven emitter can reach, keyed the same way as the
 * cache.
 *
 * Attributed by reach rather than by presence: a torch two cells outside a
 * chunk still lights into it, and a chunk that missed that would hold its first
 * phase for ever while the torch next door flickered. Attribution the other way
 * round — charging every chunk in the bake — would work too, and would expire
 * the whole window on every tick of a single torch's cycle.
 */
function animatedByChunk(
  emitters: readonly AnimatedEmitter[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of emitters) {
    const reach = litReach(e.radius);
    for (let cy = chunkOf(e.y - reach); cy <= chunkOf(e.y + reach); cy++) {
      for (let cx = chunkOf(e.x - reach); cx <= chunkOf(e.x + reach); cx++) {
        const key = chunkCacheKey(cx, cy);
        let ids = out.get(key);
        if (!ids) {
          ids = new Set();
          out.set(key, ids);
        }
        ids.add(e.tileId);
      }
    }
  }
  return out;
}

/**
 * Bake every chunk covering `rect` in one pass, as of `timeMs` on the animation
 * clock. Batching matters: the apron is per-bake, not per-chunk, so filling nine
 * chunks together costs far less than nine separate bakes of the same chunks.
 */
export function bakeRegion(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  omitLightTileIds: ReadonlySet<string> | undefined,
  rect: WorldRect,
  timeMs: number,
): Map<string, BakedChunk> {
  const padded: WorldRect = {
    x0: rect.x0 - LIGHT_APRON,
    y0: rect.y0 - LIGHT_APRON,
    x1: rect.x1 + LIGHT_APRON,
    y1: rect.y1 + LIGHT_APRON,
  };
  // The domain does both jobs: it bounds which cells are read — the apron
  // covers every occluder and emitter that can reach in — and it fixes what
  // comes out, so an empty neighbourhood cannot shrink the region and blank
  // out the chunk's interior.
  const grid = computeLightingFlood(
    map,
    tilesById,
    undefined,
    omitLightTileIds,
    { ...padded, z0: MIN_LEVEL, z1: MAX_LEVEL },
    timeMs,
  );
  const animated = animatedByChunk(grid.animated);

  const out = new Map<string, BakedChunk>();
  for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
    for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
      const cr = chunkRect(cx, cy);
      const planes: ChunkLight = new Map();
      for (const [z, level] of grid.levels) planes.set(z, sliceChunk(level, cr));
      const key = chunkCacheKey(cx, cy);
      out.set(key, {
        planes,
        animated: [...(animated.get(key) ?? [])].sort(),
      });
    }
  }
  return out;
}

/**
 * Chunk-granular light cache. Holds baked chunks across frames; a caller asks
 * for the rect it is about to draw and only the missing chunks are baked.
 */
export class ChunkedLighting {
  private cache = new Map<string, CachedChunk>();
  private lastBakedChunks = 0;
  private version = 0;
  /**
   * Last grid handed out. Re-returned by identity while nothing has changed, so
   * a caller can drive this every frame and use `===` to decide whether to redo
   * whatever it derived — an upload, say — without diffing pixels.
   *
   * Ambient is part of the assemble key: sky/block stay cached across time-of-day
   * changes; only the composed RGB grid is rebuilt.
   */
  private assembled: { key: string; grid: LightGrid } | null = null;
  private packed: { key: string; grid: PackedLightGrid } | null = null;
  /** Monotonic call counter; the LRU's clock. */
  private tick = 0;
  /** @see defPhase */
  private phaseMemo: { timeMs: number; byDef: Map<string, string> } | null =
    null;
  /** Window centre last call, for inferring which way to prefetch. */
  private lastCentre: { x: number; y: number } | null = null;
  /** Monotonic edit counter, stamped onto chunks as {@link CachedChunk.dirtyAt}. */
  private dirtySeq = 0;
  private inFlight = 0;
  private baker: ChunkBaker | null = null;
  /**
   * A chunk the window is drawing is out of date. Set by {@link refreshStale}
   * whether or not it managed to act, so the prefetch can stand aside for it.
   */
  private refreshWanted = false;

  constructor(
    private readonly tilesById: Record<string, TileDef>,
    private readonly omitLightTileIds?: ReadonlySet<string>,
    private readonly maxChunks: number = DEFAULT_MAX_CACHED_CHUNKS,
  ) {}

  /**
   * Send bakes somewhere else from now on, keeping stale light on screen until
   * they land. Null to go back to baking in the calling frame.
   *
   * Set rather than injected because the thing on the other end is a worker,
   * which cannot be built during SSR or under a test runner — so a caller that
   * has one attaches it, and everything else gets the synchronous cache it
   * always had.
   */
  setBaker(baker: ChunkBaker | null) {
    this.baker = baker;
  }

  /** Chunks holding pixels from before an edit, waiting on a refresh. */
  get staleChunks(): number {
    let n = 0;
    for (const entry of this.cache.values()) if (entry.stale) n++;
    return n;
  }

  /** Chunks baked during the most recent {@link gridFor} — for tests and probes. */
  get bakedLastCall(): number {
    return this.lastBakedChunks;
  }

  get cachedChunks(): number {
    return this.cache.size;
  }

  /**
   * Where the clock-driven emitters reaching this chunk are in their cycles.
   *
   * The empty string — every chunk no flicker reaches — is the common case by a
   * wide margin, and it is what makes the clock free for the rest of the world:
   * a chunk with no animated emitter has one baked phase and never leaves it.
   */
  private phaseOf(animated: readonly string[], timeMs: number): string {
    if (!animated.length) return "";
    let phase = "";
    for (const id of animated) phase += `${id}@${this.defPhase(id, timeMs)}|`;
    return phase;
  }

  /**
   * One tile's phase at this clock reading, memoised for the reading.
   *
   * A frame asks the same question of the same handful of tiles once per chunk
   * of the window, and up to three times over — the fill, the phase key and the
   * stitch each want it. Answering it means walking a tile's frames, so without
   * this the window's chunk count multiplies work that has exactly one answer
   * per frame.
   */
  private defPhase(id: string, timeMs: number): string {
    if (this.phaseMemo?.timeMs !== timeMs) {
      this.phaseMemo = { timeMs, byDef: new Map() };
    }
    const cached = this.phaseMemo.byDef.get(id);
    if (cached != null) return cached;
    const def = this.tilesById[id];
    const phase = def ? tileEmissionPhase(def, timeMs) : "";
    this.phaseMemo.byDef.set(id, phase);
    return phase;
  }

  /** This chunk's light for the phase the clock is at, if it is baked. */
  private cachedPlanes(
    cx: number,
    cy: number,
    timeMs: number,
  ): ChunkLight | undefined {
    const entry = this.cache.get(chunkCacheKey(cx, cy));
    if (!entry) return undefined;
    return entry.byPhase.get(this.phaseOf(entry.animated, timeMs));
  }

  /**
   * The planes this chunk will actually be drawn from, and the phase they were
   * baked at.
   *
   * The phase the clock is at when it is held, and any phase at all when it is
   * not. That fallback only ever comes up with a {@link ChunkBaker} attached —
   * without one a missing phase is baked in this very call — and it is what
   * lets a torch's *first* turn of its cycle happen off-thread too: a frame
   * showing last phase's light beats a frame stalling to bake this one.
   *
   * The phase comes back with the planes because the caller has to key its
   * cache on what was drawn rather than on what was wanted. Keying on the want
   * would hold the assembled grid steady while the fallback was on screen, and
   * the exact phase would land into a cache that had no reason to re-stitch.
   */
  private drawable(
    cx: number,
    cy: number,
    timeMs: number,
  ): { phase: string; planes: ChunkLight } | undefined {
    const entry = this.cache.get(chunkCacheKey(cx, cy));
    if (!entry) return undefined;
    const want = this.phaseOf(entry.animated, timeMs);
    const exact = entry.byPhase.get(want);
    if (exact) return { phase: want, planes: exact };
    const any = entry.byPhase.entries().next();
    if (any.done) return undefined;
    return { phase: any.value[0], planes: any.value[1] };
  }

  /**
   * File a freshly baked chunk under the phase it was baked at.
   *
   * `at` is the dirty counter as it stood when this bake was *asked for*; see
   * {@link CachedChunk.dirtyAt}. Only meaningful for a bake that went somewhere
   * else and came back — a synchronous one passes the counter as it is now,
   * which can never be behind.
   */
  private store(key: string, baked: BakedChunk, timeMs: number, at: number) {
    const entry = this.cache.get(key) ?? {
      byPhase: new Map<string, ChunkLight>(),
      animated: baked.animated,
      usedAt: this.tick,
      stale: false,
      dirtyAt: at,
    };
    // A rebake is the authority on what reaches this chunk — a torch may have
    // been placed or removed since — and phases keyed off the old answer would
    // no longer be addressable, so they go with it.
    if (entry.animated.join() !== baked.animated.join()) {
      entry.byPhase.clear();
      entry.animated = baked.animated;
    }
    // Every phase held by a stale chunk predates the edit, not just the one
    // being replaced, so a flicker must not be left alternating between the
    // world before and the world after. This bake is newer than all of them
    // whether or not it caught the latest edit, so it replaces the lot.
    if (entry.stale) entry.byPhase.clear();
    entry.byPhase.set(this.phaseOf(baked.animated, timeMs), baked.planes);
    entry.usedAt = this.tick;
    if (entry.dirtyAt <= at) entry.stale = false;
    this.cache.set(key, entry);
  }

  /** File a whole region's worth, all baked at the same clock reading. */
  private storeAll(
    baked: Map<string, BakedChunk>,
    timeMs: number,
    at: number,
  ) {
    for (const [key, chunk] of baked) this.store(key, chunk, timeMs, at);
  }

  /**
   * Forget chunks an edit at this cell could have changed.
   *
   * `reach` is how far the edit's effect travels, in cells. It defaults to
   * {@link LIGHT_APRON} — the sky flood's span, and the only safe answer when
   * an edit changes what blocks light. An edit that only changes what a cell
   * *emits* travels no further than that emitter's own radius, which is
   * typically half as far and a quarter of the chunks; see {@link editReach}.
   */
  invalidateAt(x: number, y: number, reach: number = LIGHT_APRON) {
    const lo = { cx: chunkOf(x - reach), cy: chunkOf(y - reach) };
    const hi = { cx: chunkOf(x + reach), cy: chunkOf(y + reach) };
    for (let cy = lo.cy; cy <= hi.cy; cy++) {
      for (let cx = lo.cx; cx <= hi.cx; cx++) {
        const key = chunkCacheKey(cx, cy);
        if (!this.baker) {
          if (this.cache.delete(key)) this.version++;
          continue;
        }
        // Marked, not dropped, and deliberately without a version bump: the
        // pixels have not changed, so nothing needs re-stitching or re-uploading
        // until the refresh actually lands. A frame or two of light from just
        // before the edit is invisible; the hole left by dropping the chunk
        // would not be.
        const entry = this.cache.get(key);
        if (!entry) continue;
        entry.stale = true;
        entry.dirtyAt = ++this.dirtySeq;
      }
    }
  }

  invalidateAll() {
    if (this.cache.size) this.version++;
    this.cache.clear();
  }

  /**
   * Drop chunks affected by the edits between two map versions.
   *
   * Map mutation is persistent ({@link setStack} rebuilds only the level and
   * cell it touches), so identity does the heavy lifting: an untouched map is
   * one reference compare and an untouched level is one more. Only cells that
   * feed a *cached* chunk are then compared, which bounds the scan by the cache
   * rather than by the world — the whole point of chunking in the first place.
   */
  syncTo(prev: MapFile | null, next: MapFile) {
    // No baseline to diff against — anything held could predate an edit we
    // never saw, so the only safe reading of "unknown" is "stale".
    if (!prev) {
      this.invalidateAll();
      return;
    }
    if (prev === next) return;

    const levelKeys = new Set([
      ...Object.keys(prev.levels),
      ...Object.keys(next.levels),
    ]);
    for (const lz of levelKeys) {
      const before = prev.levels[lz];
      const after = next.levels[lz];
      if (before !== after) this.invalidateChangedChunks(before, after);
    }
  }

  /**
   * Narrow a changed level to the chunks that actually differ.
   *
   * Chunked storage means an edit rewrites one chunk and leaves its neighbours
   * identical, so this skips almost everything on a normal edit — the level's
   * other thousands of cells never get looked at.
   */
  private invalidateChangedChunks(
    before: LevelChunks | undefined,
    after: LevelChunks | undefined,
  ) {
    const chunkKeys = new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after ?? {}),
    ]);
    for (const chk of chunkKeys) {
      const a = before?.[chk];
      const b = after?.[chk];
      if (a !== b) this.invalidateChangedCells(a, b);
    }
  }

  /**
   * Invalidate around cells whose *bake-relevant* content changed.
   *
   * Driven off the level's own keys rather than by sweeping each cached chunk's
   * apron. The sweep visited every cell of every cached chunk and built a
   * coordinate string for each — hundreds of thousands of allocations to find
   * the one cell that actually moved.
   */
  private invalidateChangedCells(
    before: ChunkCells | undefined,
    after: ChunkCells | undefined,
  ) {
    for (const key in after) {
      if (before?.[key] === after[key]) continue;
      this.invalidateIfLit(key, before?.[key], after[key]);
    }
    for (const key in before) {
      if (after?.[key] !== undefined) continue;
      this.invalidateIfLit(key, before[key], undefined);
    }
  }

  private invalidateIfLit(
    key: string,
    before: PlacedTile[] | undefined,
    after: PlacedTile[] | undefined,
  ) {
    const reach = this.editReach(before, after);
    if (reach == null) return;
    const { x, y } = parseCoordKey(key);
    this.invalidateAt(x, y, reach);
  }

  /**
   * How far this cell's edit can have changed the bake, in cells, or null when
   * it cannot have changed it at all.
   *
   * A door opening and a lamp switching on are not the same size of edit, and
   * charging both the sky flood's {@link LIGHT_APRON} was costing four chunks
   * where one would do. Occlusion is the expensive kind: shadows and sky spill
   * travel the full apron, so any change to what blocks light pays it. Emission
   * is bounded by the emitter's own radius — half the apron for a torch, a
   * third for the cat.
   *
   * Order matters: occlusion is checked first because a stack whose occluders
   * changed may also have moved its emitters' elevation, and the wider reach
   * covers both.
   */
  private editReach(
    before: PlacedTile[] | undefined,
    after: PlacedTile[] | undefined,
  ): number | null {
    if (this.occlusionSignature(before) !== this.occlusionSignature(after)) {
      return LIGHT_APRON;
    }
    if (this.emissionSignature(before) === this.emissionSignature(after)) {
      return null;
    }
    const reach = Math.max(
      this.emissionReach(before),
      this.emissionReach(after),
    );
    return reach > 0 ? Math.ceil(reach) : null;
  }

  /**
   * What this stack contributes to occlusion and to stack geometry.
   *
   * Written in terms of the three properties the bake actually reads rather
   * than the tile id, and that distinction is the whole point. A pressure plate
   * pressing is a swap to a different id with identical height, volume and
   * light-passing — it cannot move a single photon, and keying on the id
   * charged it the full sky apron anyway. A door opening changes light-passing
   * and volume, so it still pays.
   *
   * Facing is absent: nothing in the occlusion model reads direction, so a
   * signpost turning round cannot cast a different shadow. Order is kept,
   * because it sets the elevation every emitter above it sits at.
   *
   * Tiles whose light is painted dynamically are skipped — but only when they
   * also pass light, since an omitted emitter that still casts a shadow is very
   * much part of the bake. The player is the motivating case: it changes cell
   * every step and is light-passing, so without this every step dirties the
   * chunks around it and rebakes them for no visible change at all.
   */
  private occlusionSignature(stack: PlacedTile[] | undefined): string {
    if (!stack?.length) return "";
    let sig = "";
    for (const placed of stack) {
      if (this.omittedFromBake(placed)) continue;
      const def = this.tilesById[placed.tileId];
      // An unknown id contributes nothing to the bake, but two different
      // unknowns must not compare equal to two different knowns by accident.
      if (!def) {
        sig += `?${placed.tileId}|`;
        continue;
      }
      // height drives opacity and sealing; physical height drives the elevation
      // emitters above sit at; light-passing decides whether it occludes at all.
      sig += `${def.height},${physicalHeight(def)},${resolveLightPassing(def) ? 1 : 0}|`;
    }
    return sig;
  }

  /**
   * What this stack emits, as a comparable string. Facing counts here — a
   * directional torch lights a different cone each way round.
   */
  private emissionSignature(stack: PlacedTile[] | undefined): string {
    if (!stack?.length) return "";
    let sig = "";
    for (const placed of stack) {
      if (this.omittedFromBake(placed)) continue;
      const def = this.tilesById[placed.tileId];
      if (!def || !tileCanEmitLight(def)) continue;
      sig += `${placed.tileId}:${placed.direction ?? ""}|`;
    }
    return sig;
  }

  /** Furthest any emitter in this stack reaches, in cells. */
  private emissionReach(stack: PlacedTile[] | undefined): number {
    let reach = 0;
    for (const placed of stack ?? []) {
      if (this.omittedFromBake(placed)) continue;
      const def = this.tilesById[placed.tileId];
      if (!def) continue;
      const radius = maxLightRadius(def);
      if (radius > reach) reach = radius;
    }
    return reach;
  }

  /** Painted dynamically *and* casting no shadow, so the static bake ignores it. */
  private omittedFromBake(placed: PlacedTile): boolean {
    if (!this.omitLightTileIds?.has(placed.tileId)) return false;
    const def = this.tilesById[placed.tileId];
    return Boolean(def && resolveLightPassing(def));
  }

  /**
   * Light covering `rect`, baking whatever is not cached yet.
   *
   * When the window is already covered this also trickles in one ring chunk, so
   * the boundary the player is walking towards is warm by the time they reach
   * it. That work only happens on calls that had nothing else to do, which is
   * why it costs a frame that was otherwise idle instead of the frame where a
   * chunk edge is crossed.
   */
  gridFor(
    map: MapFile,
    ambient: [number, number, number],
    rect: WorldRect,
    timeMs = 0,
  ): LightGrid {
    this.tick++;
    this.fillMissing(map, rect, timeMs);
    // Nothing on screen is waiting, so it is worth warming what might be.
    if (this.lastBakedChunks === 0 && !this.refreshWanted) {
      this.prefetchRing(map, rect, timeMs);
    }

    const ambientKey = ambient.map((c) => c.toFixed(4)).join(",");
    const key = [
      chunkSpanKey(rect),
      this.version,
      ambientKey,
      this.windowPhaseKey(rect, timeMs),
    ].join("|");
    if (this.assembled?.key === key) {
      this.touchWindow(rect);
      this.evictColdest();
      return this.assembled.grid;
    }
    const grid = this.assemble(rect, ambient, timeMs);
    this.assembled = { key, grid };
    this.evictColdest();
    return grid;
  }

  /**
   * Where every flicker the window can see is in its cycle.
   *
   * Part of the assemble key, and only the window's own chunks contribute: a
   * torch burning three streets away must not re-stitch and re-upload the grid
   * in front of the player several times a second.
   */
  private windowPhaseKey(rect: WorldRect, timeMs: number): string {
    let key = "";
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const entry = this.cache.get(chunkCacheKey(cx, cy));
        if (!entry?.animated.length) continue;
        // The phase on screen, not the phase the clock is at. The two differ
        // only while a chunk is waiting on a bake of the phase it wants, and
        // keying on the want would then describe a grid that was never
        // assembled.
        //
        // Belt and braces today: the refresh that ends that gap bumps
        // `version`, which is in this key too, so the re-stitch would happen
        // either way. Written from what was drawn regardless, because the
        // alternative is a cache key that is only accidentally right and a
        // caller using grid identity to decide whether to re-upload.
        key += this.drawable(cx, cy, timeMs)?.phase ?? "";
      }
    }
    return key;
  }

  /**
   * Bake one missing chunk from the ring around `rect`, nearest the direction of
   * travel. Direction is inferred from how the window itself moved, so it needs
   * no coupling to the player — a camera panning in the editor gets the same
   * treatment as a character walking.
   */
  private prefetchRing(map: MapFile, rect: WorldRect, timeMs: number) {
    const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
    const drift = this.lastCentre
      ? { x: centre.x - this.lastCentre.x, y: centre.y - this.lastCentre.y }
      : { x: 0, y: 0 };
    this.lastCentre = centre;

    const missing = this.ringCandidates(rect, timeMs);
    if (!missing.length) return;

    // Ahead of the window first; distance only breaks ties, so a stationary
    // camera still fills its ring rather than stalling.
    missing.sort(
      (a, b) =>
        prefetchScore(b, centre, drift) - prefetchScore(a, centre, drift),
    );

    // Note the absence of a version bump below. Prefetched chunks are outside
    // the window by construction — this only runs when the window is already
    // covered — so the assembled grid is unaffected, and bumping would force a
    // pointless re-stitch and texture upload on every quiet frame.
    for (const c of missing.slice(0, PREFETCH_CHUNKS_PER_CALL)) {
      const rect = chunkRect(c.cx, c.cy);
      // Nothing is drawing this chunk yet, so there is no reason at all to bake
      // it here — and every reason not to, since this runs on quiet frames and
      // was the one thing still costing them.
      if (this.baker) {
        if (this.inFlight >= MAX_INFLIGHT_BAKES) continue;
        const at = this.dirtySeq;
        this.inFlight++;
        void this.baker
          .bake(rect, timeMs)
          .then((baked) => this.storeAll(baked, timeMs, at))
          .catch(() => {})
          .finally(() => {
            this.inFlight--;
          });
        continue;
      }
      this.storeAll(
        bakeRegion(map, this.tilesById, this.omitLightTileIds, rect, timeMs),
        timeMs,
        this.dirtySeq,
      );
    }
  }

  /** Uncached chunks in the ring around the window. */
  private ringCandidates(
    rect: WorldRect,
    timeMs: number,
  ): Array<{ cx: number; cy: number }> {
    const out: Array<{ cx: number; cy: number }> = [];
    const r = PREFETCH_RING_CHUNKS;
    for (let cy = chunkOf(rect.y0) - r; cy <= chunkOf(rect.y1) + r; cy++) {
      for (let cx = chunkOf(rect.x0) - r; cx <= chunkOf(rect.x1) + r; cx++) {
        if (this.cachedPlanes(cx, cy, timeMs)) continue;
        out.push({ cx, cy });
      }
    }
    return out;
  }

  /** Mark the window's chunks as used this tick so the LRU cannot drop them. */
  private touchWindow(rect: WorldRect) {
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const entry = this.cache.get(chunkCacheKey(cx, cy));
        if (entry) entry.usedAt = this.tick;
      }
    }
  }

  /** Baked planes held, counting a chunk once per phase it has been baked at. */
  private cachedVariants(): number {
    let n = 0;
    for (const entry of this.cache.values()) n += entry.byPhase.size;
    return n;
  }

  /**
   * Drop the coldest chunks once over budget, never one the window is using —
   * evicting those would rebake them on the very next call.
   *
   * The budget is spent in *baked planes*, not chunks: a chunk a torch flickers
   * into holds one set per phase of the flicker, and counting it as one would
   * quietly let the cache grow past the memory it is supposed to bound.
   */
  private evictColdest() {
    let over = this.cachedVariants() - this.maxChunks;
    if (over <= 0) return;
    const evictable = [...this.cache.entries()]
      .filter(([, entry]) => entry.usedAt !== this.tick)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, entry] of evictable) {
      if (over <= 0) break;
      this.cache.delete(key);
      over -= entry.byPhase.size;
    }
  }

  /**
   * Bake the chunks in `rect` there is nothing at all to draw for, batched into
   * one pass over their bounding box. Filling the union costs a single apron
   * rather than one each.
   *
   * What counts as nothing depends on whether there is a baker. Without one,
   * a chunk missing the phase the clock is at is missing, full stop — the bake
   * has to happen here or the flicker is wrong. With one, any phase will do to
   * draw from for a frame or two, so only a chunk with no phase at all is worth
   * stopping for, and the exact phase is fetched off-thread.
   */
  private fillMissing(map: MapFile, rect: WorldRect, timeMs: number) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const held = this.baker
          ? this.drawable(cx, cy, timeMs)
          : this.cachedPlanes(cx, cy, timeMs);
        if (held) continue;
        const cr = chunkRect(cx, cy);
        if (cr.x0 < x0) x0 = cr.x0;
        if (cr.y0 < y0) y0 = cr.y0;
        if (cr.x1 > x1) x1 = cr.x1;
        if (cr.y1 > y1) y1 = cr.y1;
      }
    }

    if (!Number.isFinite(x0)) {
      this.lastBakedChunks = 0;
      this.refreshStale(rect, timeMs);
      return;
    }

    // Absent, not merely out of date: there are no pixels to show for this
    // chunk at all, so waiting on another thread would mean drawing a hole
    // where the world is. Baked here, in this frame, whether or not there is a
    // baker — which confines the synchronous cost to a cold window, and leaves
    // every edit after it to {@link refreshStale}.
    const baked = bakeRegion(
      map,
      this.tilesById,
      this.omitLightTileIds,
      { x0, y0, x1, y1 },
      timeMs,
    );
    this.storeAll(baked, timeMs, this.dirtySeq);
    this.lastBakedChunks = baked.size;
    this.version++;
    this.refreshStale(rect, timeMs);
  }

  /**
   * Ask the baker to redo the window's chunks that are showing the wrong thing.
   *
   * Two kinds, and they are the same kind: a chunk left stale by an edit, and a
   * chunk drawing one phase of a flicker while the clock is at another. Both
   * have pixels good enough to keep for now and both want a bake nobody is
   * waiting on.
   *
   * One request covering their bounding box rather than one each, for the same
   * reason {@link fillMissing} batches: the apron is per-bake, so a region costs
   * far less than its chunks do separately.
   */
  private refreshStale(rect: WorldRect, timeMs: number) {
    const baker = this.baker;

    // Scanned before the guards rather than after, so `refreshWanted` is set
    // even on the calls that cannot act on it. That flag is what keeps the
    // prefetch — speculative work for chunks nobody is looking at — from taking
    // the one in-flight slot while something on screen is out of date. Without
    // it a quiet frame's prefetch could sit in front of the refresh for an
    // edit, and the light would wait a frame on work for a chunk off-screen.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const entry = this.cache.get(chunkCacheKey(cx, cy));
        if (!entry) continue;
        const wanted = this.phaseOf(entry.animated, timeMs);
        if (!entry.stale && entry.byPhase.has(wanted)) continue;
        const cr = chunkRect(cx, cy);
        if (cr.x0 < x0) x0 = cr.x0;
        if (cr.y0 < y0) y0 = cr.y0;
        if (cr.x1 > x1) x1 = cr.x1;
        if (cr.y1 > y1) y1 = cr.y1;
      }
    }
    this.refreshWanted = Number.isFinite(x0);
    if (!this.refreshWanted) return;
    if (!baker || this.inFlight >= MAX_INFLIGHT_BAKES) return;

    // Captured before the request goes out, and compared when it comes back:
    // anything invalidated in between leaves its chunk stale so the next call
    // asks again. See {@link CachedChunk.dirtyAt}.
    const at = this.dirtySeq;
    this.inFlight++;
    void baker
      .bake({ x0, y0, x1, y1 }, timeMs)
      .then((baked) => {
        this.storeAll(baked, timeMs, at);
        this.version++;
      })
      .catch(() => {
        // A refusal is survivable — the chunks are stale, not missing, so the
        // world keeps its slightly-old light and the next call asks again.
      })
      .finally(() => {
        this.inFlight--;
      });
  }


  /**
   * Light covering `rect` in the GPU's own layout, untinted.
   *
   * No ambient anywhere in this path: chunk planes are already interleaved
   * RGBA, so stitching is row copies and the tint happens per fragment. This is
   * the path a continuously moving clock should use — changing time of day
   * touches a uniform and nothing else.
   */
  packedGridFor(
    map: MapFile,
    rect: WorldRect,
    timeMs = 0,
  ): PackedLightGrid {
    this.tick++;
    this.fillMissing(map, rect, timeMs);
    // Nothing on screen is waiting, so it is worth warming what might be.
    if (this.lastBakedChunks === 0 && !this.refreshWanted) {
      this.prefetchRing(map, rect, timeMs);
    }

    const key = [
      "packed",
      chunkSpanKey(rect),
      this.version,
      this.windowPhaseKey(rect, timeMs),
    ].join("|");
    if (this.packed?.key === key) {
      this.touchWindow(rect);
      this.evictColdest();
      return this.packed.grid;
    }
    const grid = this.assemblePacked(rect, timeMs);
    this.packed = { key, grid };
    this.evictColdest();
    return grid;
  }

  private assemblePacked(rect: WorldRect, timeMs: number): PackedLightGrid {
    const cx0 = chunkOf(rect.x0);
    const cy0 = chunkOf(rect.y0);
    const cx1 = chunkOf(rect.x1);
    const cy1 = chunkOf(rect.y1);
    const x0 = cx0 * LIGHT_CHUNK_SIZE;
    const y0 = cy0 * LIGHT_CHUNK_SIZE;
    const w = (cx1 - cx0 + 1) * LIGHT_CHUNK_SIZE;
    const h = (cy1 - cy0 + 1) * LIGHT_CHUNK_SIZE;

    const planesByZ = new Map<number, Uint8Array>();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const held = this.drawable(cx, cy, timeMs);
        if (!held) continue;
        this.cache.get(chunkCacheKey(cx, cy))!.usedAt = this.tick;
        blitPacked(planesByZ, held.planes, cx - cx0, cy - cy0, w, h);
      }
    }

    const levels = new Map<number, PackedLevelLight>();
    for (const [z, rgba] of planesByZ) levels.set(z, { x0, y0, w, h, rgba });
    return { levels };
  }

  /** Stitch cached chunks into one RGB grid covering `rect`, tinted by ambient. */
  private assemble(
    rect: WorldRect,
    ambient: [number, number, number],
    timeMs: number,
  ): LightGrid {
    const cx0 = chunkOf(rect.x0);
    const cy0 = chunkOf(rect.y0);
    const cx1 = chunkOf(rect.x1);
    const cy1 = chunkOf(rect.y1);
    const x0 = cx0 * LIGHT_CHUNK_SIZE;
    const y0 = cy0 * LIGHT_CHUNK_SIZE;
    const w = (cx1 - cx0 + 1) * LIGHT_CHUNK_SIZE;
    const h = (cy1 - cy0 + 1) * LIGHT_CHUNK_SIZE;

    const rawByZ = new Map<number, { sky: Uint8Array; block: Uint8Array }>();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const held = this.drawable(cx, cy, timeMs);
        if (!held) continue;
        this.cache.get(chunkCacheKey(cx, cy))!.usedAt = this.tick;
        this.blitChunk(rawByZ, held.planes, cx - cx0, cy - cy0, w, h);
      }
    }

    const levels = new Map<number, LevelLightMap>();
    for (const [z, raw] of rawByZ) {
      const rgb = new Uint8Array(w * h * 3);
      composeAmbientRgb(raw.sky, raw.block, ambient, rgb);
      levels.set(z, { x0, y0, w, h, rgb });
    }
    return { levels };
  }

  private blitChunk(
    rawByZ: Map<number, { sky: Uint8Array; block: Uint8Array }>,
    chunk: ChunkLight,
    ox: number,
    oy: number,
    w: number,
    h: number,
  ) {
    for (const [z, plane] of chunk) {
      let raw = rawByZ.get(z);
      if (!raw) {
        raw = {
          sky: new Uint8Array(w * h),
          block: new Uint8Array(w * h * 3),
        };
        rawByZ.set(z, raw);
      }
      for (let row = 0; row < LIGHT_CHUNK_SIZE; row++) {
        const dstRow = oy * LIGHT_CHUNK_SIZE + row;
        for (let col = 0; col < LIGHT_CHUNK_SIZE; col++) {
          const src = (row * LIGHT_CHUNK_SIZE + col) * RAW_STRIDE;
          const dstCell = dstRow * w + ox * LIGHT_CHUNK_SIZE + col;
          const dstP = dstCell * 3;
          raw.block[dstP] = plane[src]!;
          raw.block[dstP + 1] = plane[src + 1]!;
          raw.block[dstP + 2] = plane[src + 2]!;
          raw.sky[dstCell] = plane[src + 3]!;
        }
      }
    }
  }
}
