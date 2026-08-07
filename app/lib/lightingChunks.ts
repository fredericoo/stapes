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
  LightGrid,
  LevelLightMap,
  PackedLevelLight,
  PackedLightGrid,
  RawLevelLight,
} from "./lighting";
import { composeAmbientRgb } from "./lighting";
import { computeLightingFlood, MAX_LIGHT_LEVEL } from "./lightingFlood";
import { chunkifyMap, getStack } from "./mapData";
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
  coordKey,
  parseCoordKey,
  resolveLightPassing,
} from "./types";

/**
 * Chunk edge in cells. The apron is paid on every bake, so small chunks waste
 * most of their work on margin: at 16 a chunk bakes 8.3x its own area, at 32
 * it is 3.8x. Larger chunks invert the problem — a single edit then dirties a
 * bigger region. 32 is the knee, and batching (see {@link bakeRegion}) recovers
 * most of the remaining margin cost when several chunks are filled at once.
 */
export const LIGHT_CHUNK_SIZE = 32;

/** Cells of map data to read beyond a chunk so its interior bakes correctly. */
export const LIGHT_APRON = MAX_LIGHT_LEVEL;

export type WorldRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Chunks of margin kept baked beyond the window. One ring is enough: crossing a
 * 32-cell chunk takes the player seconds at walking pace, and the trickle below
 * fills it long before then.
 */
export const PREFETCH_RING_CHUNKS = 1;

/**
 * Chunks baked per idle call. Deliberately one — a chunk bake is milliseconds,
 * so filling a ring in a single frame would just relocate the hitch it exists
 * to remove. Spread over frames it disappears into the walk.
 */
export const PREFETCH_CHUNKS_PER_CALL = 1;

/**
 * Chunks held before the coldest are dropped. ~68 KiB each (RGBA raw), so this
 * caps the cache near 17 MiB. Must comfortably exceed the window's chunk count
 * or the window would evict itself and rebake every frame.
 */
export const DEFAULT_MAX_CACHED_CHUNKS = 256;

/**
 * Per-chunk light: one plane per level, `LIGHT_CHUNK_SIZE` square.
 * Layout is RGBA: block R,G,B + sky factor — ambient is applied at assemble.
 */
type ChunkLight = Map<number, Uint8Array>;

type CachedChunk = {
  planes: ChunkLight;
  /** Tick this chunk was last drawn from — the LRU's recency stamp. */
  usedAt: number;
};

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

function chunkRect(cx: number, cy: number): WorldRect {
  const x0 = cx * LIGHT_CHUNK_SIZE;
  const y0 = cy * LIGHT_CHUNK_SIZE;
  return { x0, y0, x1: x0 + LIGHT_CHUNK_SIZE - 1, y1: y0 + LIGHT_CHUNK_SIZE - 1 };
}

function cropLevel(
  map: MapFile,
  z: number,
  rect: WorldRect,
): Record<string, PlacedTile[]> {
  const kept: Record<string, PlacedTile[]> = {};
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const stack = getStack(map, x, y, z);
      if (stack.length) kept[coordKey(x, y)] = stack;
    }
  }
  return kept;
}

/**
 * Cells of `map` inside `rect`, gathered by addressing the rect rather than
 * filtering the map. Scanning every cell would put the whole point of this
 * module back — the bake would be bounded but the gather feeding it would
 * still be O(world), which is the same cliff one level down.
 */
function cropMap(map: MapFile, rect: WorldRect): MapFile {
  const levels: Record<string, Record<string, PlacedTile[]>> = {};
  for (const lz of Object.keys(map.levels)) {
    const kept = cropLevel(map, Number(lz), rect);
    for (const _ in kept) {
      levels[lz] = kept;
      break;
    }
  }
  return chunkifyMap({ version: 1, levels });
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
 * Bake every chunk covering `rect` in one pass. Batching matters: the apron is
 * per-bake, not per-chunk, so filling nine chunks together costs far less than
 * nine separate bakes of the same chunks.
 */
function bakeRegion(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  omitLightTileIds: ReadonlySet<string> | undefined,
  rect: WorldRect,
): Map<string, ChunkLight> {
  const padded: WorldRect = {
    x0: rect.x0 - LIGHT_APRON,
    y0: rect.y0 - LIGHT_APRON,
    x1: rect.x1 + LIGHT_APRON,
    y1: rect.y1 + LIGHT_APRON,
  };
  // Crop supplies the occluders and emitters that reach in; the domain fixes
  // what comes out. Both are needed — the crop alone would let an empty
  // neighbourhood shrink the domain inside the chunk and blank it out.
  const grid = computeLightingFlood(
    cropMap(map, padded),
    tilesById,
    undefined,
    omitLightTileIds,
    { ...padded, z0: MIN_LEVEL, z1: MAX_LEVEL },
  );

  const out = new Map<string, ChunkLight>();
  for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
    for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
      const cr = chunkRect(cx, cy);
      const planes: ChunkLight = new Map();
      for (const [z, level] of grid.levels) planes.set(z, sliceChunk(level, cr));
      out.set(chunkCacheKey(cx, cy), planes);
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
  /** Window centre last call, for inferring which way to prefetch. */
  private lastCentre: { x: number; y: number } | null = null;

  constructor(
    private readonly tilesById: Record<string, TileDef>,
    private readonly omitLightTileIds?: ReadonlySet<string>,
    private readonly maxChunks: number = DEFAULT_MAX_CACHED_CHUNKS,
  ) {}

  /** Chunks baked during the most recent {@link gridFor} — for tests and probes. */
  get bakedLastCall(): number {
    return this.lastBakedChunks;
  }

  get cachedChunks(): number {
    return this.cache.size;
  }

  /**
   * Forget chunks an edit at this cell could have changed. Light reaches
   * {@link LIGHT_APRON} cells, so the dirty area is that far out in every
   * direction — typically one to four chunks, never the world.
   */
  invalidateAt(x: number, y: number) {
    const lo = { cx: chunkOf(x - LIGHT_APRON), cy: chunkOf(y - LIGHT_APRON) };
    const hi = { cx: chunkOf(x + LIGHT_APRON), cy: chunkOf(y + LIGHT_APRON) };
    for (let cy = lo.cy; cy <= hi.cy; cy++) {
      for (let cx = lo.cx; cx <= hi.cx; cx++) {
        if (this.cache.delete(chunkCacheKey(cx, cy))) this.version++;
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
    if (this.bakeSignature(before) === this.bakeSignature(after)) return;
    const { x, y } = parseCoordKey(key);
    this.invalidateAt(x, y);
  }

  /**
   * What this stack contributes to a static bake, as a comparable string.
   *
   * Tiles whose light is painted dynamically are skipped — but only when they
   * also pass light, since an omitted emitter that still casts a shadow is very
   * much part of the bake. The player is the motivating case: it changes cell
   * every step and is light-passing, so without this every step dirties the
   * chunks around it and rebakes them for no visible change at all.
   */
  private bakeSignature(stack: PlacedTile[] | undefined): string {
    if (!stack?.length) return "";
    let sig = "";
    for (const placed of stack) {
      if (this.omitLightTileIds?.has(placed.tileId)) {
        const def = this.tilesById[placed.tileId];
        if (def && resolveLightPassing(def)) continue;
      }
      sig += `${placed.tileId}:${placed.direction ?? ""}|`;
    }
    return sig;
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
  ): LightGrid {
    this.tick++;
    this.fillMissing(map, rect);
    if (this.lastBakedChunks === 0) this.prefetchRing(map, rect);

    const ambientKey = ambient.map((c) => c.toFixed(4)).join(",");
    const key = `${rect.x0},${rect.y0},${rect.x1},${rect.y1}|${this.version}|${ambientKey}`;
    if (this.assembled?.key === key) {
      this.touchWindow(rect);
      this.evictColdest();
      return this.assembled.grid;
    }
    const grid = this.assemble(rect, ambient);
    this.assembled = { key, grid };
    this.evictColdest();
    return grid;
  }

  /**
   * Bake one missing chunk from the ring around `rect`, nearest the direction of
   * travel. Direction is inferred from how the window itself moved, so it needs
   * no coupling to the player — a camera panning in the editor gets the same
   * treatment as a character walking.
   */
  private prefetchRing(map: MapFile, rect: WorldRect) {
    const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
    const drift = this.lastCentre
      ? { x: centre.x - this.lastCentre.x, y: centre.y - this.lastCentre.y }
      : { x: 0, y: 0 };
    this.lastCentre = centre;

    const missing = this.ringCandidates(rect);
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
      const baked = bakeRegion(
        map,
        this.tilesById,
        this.omitLightTileIds,
        chunkRect(c.cx, c.cy),
      );
      for (const [key, planes] of baked) {
        this.cache.set(key, { planes, usedAt: this.tick });
      }
    }
  }

  /** Uncached chunks in the ring around the window. */
  private ringCandidates(rect: WorldRect): Array<{ cx: number; cy: number }> {
    const out: Array<{ cx: number; cy: number }> = [];
    const r = PREFETCH_RING_CHUNKS;
    for (let cy = chunkOf(rect.y0) - r; cy <= chunkOf(rect.y1) + r; cy++) {
      for (let cx = chunkOf(rect.x0) - r; cx <= chunkOf(rect.x1) + r; cx++) {
        if (this.cache.has(chunkCacheKey(cx, cy))) continue;
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

  /**
   * Drop the coldest chunks once over budget, never one the window is using —
   * evicting those would rebake them on the very next call.
   */
  private evictColdest() {
    if (this.cache.size <= this.maxChunks) return;
    const evictable = [...this.cache.entries()]
      .filter(([, entry]) => entry.usedAt !== this.tick)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    let over = this.cache.size - this.maxChunks;
    for (const [key] of evictable) {
      if (over <= 0) break;
      this.cache.delete(key);
      over--;
    }
  }

  /**
   * Bake the chunks in `rect` that are absent, batched into one pass over their
   * bounding box. Filling the union costs a single apron rather than one each.
   */
  private fillMissing(map: MapFile, rect: WorldRect) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        if (this.cache.has(chunkCacheKey(cx, cy))) continue;
        const cr = chunkRect(cx, cy);
        if (cr.x0 < x0) x0 = cr.x0;
        if (cr.y0 < y0) y0 = cr.y0;
        if (cr.x1 > x1) x1 = cr.x1;
        if (cr.y1 > y1) y1 = cr.y1;
      }
    }

    if (!Number.isFinite(x0)) {
      this.lastBakedChunks = 0;
      return;
    }

    const baked = bakeRegion(
      map,
      this.tilesById,
      this.omitLightTileIds,
      { x0, y0, x1, y1 },
    );
    for (const [key, planes] of baked) {
      this.cache.set(key, { planes, usedAt: this.tick });
    }
    this.lastBakedChunks = baked.size;
    this.version++;
  }

  /**
   * Light covering `rect` in the GPU's own layout, untinted.
   *
   * No ambient anywhere in this path: chunk planes are already interleaved
   * RGBA, so stitching is row copies and the tint happens per fragment. This is
   * the path a continuously moving clock should use — changing time of day
   * touches a uniform and nothing else.
   */
  packedGridFor(map: MapFile, rect: WorldRect): PackedLightGrid {
    this.tick++;
    this.fillMissing(map, rect);
    if (this.lastBakedChunks === 0) this.prefetchRing(map, rect);

    const key = `packed|${rect.x0},${rect.y0},${rect.x1},${rect.y1}|${this.version}`;
    if (this.packed?.key === key) {
      this.touchWindow(rect);
      this.evictColdest();
      return this.packed.grid;
    }
    const grid = this.assemblePacked(rect);
    this.packed = { key, grid };
    this.evictColdest();
    return grid;
  }

  private assemblePacked(rect: WorldRect): PackedLightGrid {
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
        const chunk = this.cache.get(chunkCacheKey(cx, cy));
        if (!chunk) continue;
        chunk.usedAt = this.tick;
        blitPacked(planesByZ, chunk.planes, cx - cx0, cy - cy0, w, h);
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
        const chunk = this.cache.get(chunkCacheKey(cx, cy));
        if (!chunk) continue;
        chunk.usedAt = this.tick;
        this.blitChunk(rawByZ, chunk.planes, cx - cx0, cy - cy0, w, h);
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
