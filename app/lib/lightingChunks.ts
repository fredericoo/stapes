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
import type { ChunkCells, LevelChunks, MapFile, PlacedTile, TileDef } from "./types";
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

export const LIGHT_CHUNK_SIZE = 32;

/**
 * Equal to {@link MAX_LIGHT_LEVEL} because a block emitter's radius is
 * clamped to that same bound by `clampTileLight`. If that clamp is ever
 * loosened, this crop is no longer wide enough and a chunk's edge can go
 * dark while a wider light approaches it from outside the apron.
 */
export const LIGHT_APRON = MAX_LIGHT_LEVEL;

export const LIGHT_WINDOW_MARGIN = 4;

export type WorldRect = { x0: number; y0: number; x1: number; y1: number };

export const PREFETCH_RING_CHUNKS = 1;

export const PREFETCH_CHUNKS_PER_CALL = 1;

export const DEFAULT_MAX_CACHED_CHUNKS = 256;

export type ChunkLight = Map<number, Uint8Array>;

type CachedChunk = {
  byPhase: Map<string, ChunkLight>;
  animated: string[];
  usedAt: number;
  stale: boolean;
  dirtyAt: number;
};

export type BakedChunk = {
  planes: ChunkLight;
  animated: string[];
};

export type ChunkBaker = {
  bake(rect: WorldRect, timeMs: number): Promise<Map<string, BakedChunk>>;
};

const MAX_INFLIGHT_BAKES = 1;

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

const RAW_STRIDE = 4;

function chunkOf(v: number): number {
  return Math.floor(v / LIGHT_CHUNK_SIZE);
}

function chunkCacheKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function chunkSpanKey(rect: WorldRect): string {
  return [chunkOf(rect.x0), chunkOf(rect.y0), chunkOf(rect.x1), chunkOf(rect.y1)].join(",");
}

function chunkRect(cx: number, cy: number): WorldRect {
  const x0 = cx * LIGHT_CHUNK_SIZE;
  const y0 = cy * LIGHT_CHUNK_SIZE;
  return { x0, y0, x1: x0 + LIGHT_CHUNK_SIZE - 1, y1: y0 + LIGHT_CHUNK_SIZE - 1 };
}

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
 * `ceil(radius) - 1` because the flood reaches zero exactly at `radius`.
 * `ceil(radius)` would charge chunks the emitter never lights, and they would
 * rebake on every flicker frame.
 */
function litReach(radius: number): number {
  return Math.max(0, Math.ceil(radius) - 1);
}

function animatedByChunk(emitters: readonly AnimatedEmitter[]): Map<string, Set<string>> {
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

export class ChunkedLighting {
  private cache = new Map<string, CachedChunk>();
  private lastBakedChunks = 0;
  private version = 0;
  private assembled: { key: string; grid: LightGrid } | null = null;
  private packed: { key: string; grid: PackedLightGrid } | null = null;
  private tick = 0;
  private phaseMemo: { timeMs: number; byDef: Map<string, string> } | null = null;
  private lastCentre: { x: number; y: number } | null = null;
  private dirtySeq = 0;
  private inFlight = 0;
  private baker: ChunkBaker | null = null;
  private refreshWanted = false;

  constructor(
    private readonly tilesById: Record<string, TileDef>,
    private readonly omitLightTileIds?: ReadonlySet<string>,
    private readonly maxChunks: number = DEFAULT_MAX_CACHED_CHUNKS,
  ) {}

  setBaker(baker: ChunkBaker | null) {
    this.baker = baker;
  }

  get staleChunks(): number {
    let n = 0;
    for (const entry of this.cache.values()) if (entry.stale) n++;
    return n;
  }

  get bakedLastCall(): number {
    return this.lastBakedChunks;
  }

  get cachedChunks(): number {
    return this.cache.size;
  }

  private phaseOf(animated: readonly string[], timeMs: number): string {
    if (!animated.length) return "";
    let phase = "";
    for (const id of animated) phase += `${id}@${this.defPhase(id, timeMs)}|`;
    return phase;
  }

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

  private cachedPlanes(cx: number, cy: number, timeMs: number): ChunkLight | undefined {
    const entry = this.cache.get(chunkCacheKey(cx, cy));
    if (!entry) return undefined;
    return entry.byPhase.get(this.phaseOf(entry.animated, timeMs));
  }

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

  private store(key: string, baked: BakedChunk, timeMs: number, at: number) {
    const entry = this.cache.get(key) ?? {
      byPhase: new Map<string, ChunkLight>(),
      animated: baked.animated,
      usedAt: this.tick,
      stale: false,
      dirtyAt: at,
    };
    if (entry.animated.join() !== baked.animated.join()) {
      entry.byPhase.clear();
      entry.animated = baked.animated;
    }
    if (entry.stale) entry.byPhase.clear();
    entry.byPhase.set(this.phaseOf(baked.animated, timeMs), baked.planes);
    entry.usedAt = this.tick;
    if (entry.dirtyAt <= at) entry.stale = false;
    this.cache.set(key, entry);
  }

  private storeAll(baked: Map<string, BakedChunk>, timeMs: number, at: number) {
    for (const [key, chunk] of baked) this.store(key, chunk, timeMs, at);
  }

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

  syncTo(prev: MapFile | null, next: MapFile) {
    if (!prev) {
      this.invalidateAll();
      return;
    }
    if (prev === next) return;

    const levelKeys = new Set([...Object.keys(prev.levels), ...Object.keys(next.levels)]);
    for (const lz of levelKeys) {
      const before = prev.levels[lz];
      const after = next.levels[lz];
      if (before !== after) this.invalidateChangedChunks(before, after);
    }
  }

  private invalidateChangedChunks(before: LevelChunks | undefined, after: LevelChunks | undefined) {
    const chunkKeys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const chk of chunkKeys) {
      const a = before?.[chk];
      const b = after?.[chk];
      if (a !== b) this.invalidateChangedCells(a, b);
    }
  }

  private invalidateChangedCells(before: ChunkCells | undefined, after: ChunkCells | undefined) {
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
    const reach = Math.max(this.emissionReach(before), this.emissionReach(after));
    return reach > 0 ? Math.ceil(reach) : null;
  }

  private occlusionSignature(stack: PlacedTile[] | undefined): string {
    if (!stack?.length) return "";
    let sig = "";
    for (const placed of stack) {
      if (this.omittedFromBake(placed)) continue;
      const def = this.tilesById[placed.tileId];
      if (!def) {
        sig += `?${placed.tileId}|`;
        continue;
      }
      sig += `${def.height},${physicalHeight(def)},${resolveLightPassing(def) ? 1 : 0},${placed.foot ?? ""}|`;
    }
    return sig;
  }

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

  private omittedFromBake(placed: PlacedTile): boolean {
    if (!this.omitLightTileIds?.has(placed.tileId)) return false;
    const def = this.tilesById[placed.tileId];
    return Boolean(def && resolveLightPassing(def));
  }

  gridFor(map: MapFile, ambient: [number, number, number], rect: WorldRect, timeMs = 0): LightGrid {
    this.tick++;
    this.fillMissing(map, rect, timeMs);
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

  private windowPhaseKey(rect: WorldRect, timeMs: number): string {
    let key = "";
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const entry = this.cache.get(chunkCacheKey(cx, cy));
        if (!entry?.animated.length) continue;
        key += this.drawable(cx, cy, timeMs)?.phase ?? "";
      }
    }
    return key;
  }

  private prefetchRing(map: MapFile, rect: WorldRect, timeMs: number) {
    const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
    const drift = this.lastCentre
      ? { x: centre.x - this.lastCentre.x, y: centre.y - this.lastCentre.y }
      : { x: 0, y: 0 };
    this.lastCentre = centre;

    const missing = this.ringCandidates(rect, timeMs);
    if (!missing.length) return;

    missing.sort((a, b) => prefetchScore(b, centre, drift) - prefetchScore(a, centre, drift));

    for (const c of missing.slice(0, PREFETCH_CHUNKS_PER_CALL)) {
      const rect = chunkRect(c.cx, c.cy);
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

  private ringCandidates(rect: WorldRect, timeMs: number): Array<{ cx: number; cy: number }> {
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

  private touchWindow(rect: WorldRect) {
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const entry = this.cache.get(chunkCacheKey(cx, cy));
        if (entry) entry.usedAt = this.tick;
      }
    }
  }

  private cachedVariants(): number {
    let n = 0;
    for (const entry of this.cache.values()) n += entry.byPhase.size;
    return n;
  }

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

  private fillMissing(map: MapFile, rect: WorldRect, timeMs: number) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let cy = chunkOf(rect.y0); cy <= chunkOf(rect.y1); cy++) {
      for (let cx = chunkOf(rect.x0); cx <= chunkOf(rect.x1); cx++) {
        const held = this.baker ? this.drawable(cx, cy, timeMs) : this.cachedPlanes(cx, cy, timeMs);
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

  private refreshStale(rect: WorldRect, timeMs: number) {
    const baker = this.baker;

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

    const at = this.dirtySeq;
    this.inFlight++;
    void baker
      .bake({ x0, y0, x1, y1 }, timeMs)
      .then((baked) => {
        this.storeAll(baked, timeMs, at);
        this.version++;
      })
      .catch(() => {})
      .finally(() => {
        this.inFlight--;
      });
  }

  packedGridFor(map: MapFile, rect: WorldRect, timeMs = 0): PackedLightGrid {
    this.tick++;
    this.fillMissing(map, rect, timeMs);
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

  private assemble(rect: WorldRect, ambient: [number, number, number], timeMs: number): LightGrid {
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
