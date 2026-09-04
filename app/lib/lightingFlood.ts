/**
 * Hybrid lighting bake:
 * - Sky: column seed + float flood with Euclidean edge costs (rounder than
 *   Manhattan diamonds).
 * - Block/torches: spherical falloff + occlusion DDA (same look as the old bake).
 *
 * Sky flood stays cheap; circular casts only run for the few map emitters.
 */
import type { ChunkCells, MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MAX_LIGHT_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  maxLightRadius,
  parseCoordKey,
  resolveLightPassing,
  tileCanEmitLight,
  tileLightVaries,
} from "./types";
import { chunkIndexOf, chunkKeyAt, elevationAt } from "./mapData";
import type {
  AnimatedEmitter,
  EmitterOverride,
  RawLightGrid,
  RawLevelLight,
} from "./lighting";
import { resolveLight } from "./tileResolve";

/**
 * Max sky level after column seed, and the cap an authored emitter is clamped
 * to. Defined in `./types` beside the clamp that enforces it; re-exported here
 * because this is where the sky flood spends it. Tune to widen/narrow spill.
 */
export { MAX_LIGHT_LEVEL };

const TRANSMISSION_EPSILON = 1e-3;
const VERTICAL_FALLOFF = 1;

/** A column's lowest tile level when the column holds no tile at all. */
const NO_TILE_IN_COLUMN = MAX_LEVEL + 1;

/**
 * `fullFrom` for a column that holds the full shaft nowhere: one below the
 * domain, so the frontier scan covers nothing and no neighbour is raised.
 */
const FULL_SHAFT_NOWHERE = -1;

/**
 * 6-face + 4 diagonal (XY) with Euclidean step cost — softens diamond shapes.
 *
 * Flattened into `(dx, dy, dz, cost)` runs of one typed array rather than an
 * array of tuples. The flood relaxes millions of edges, and pulling a tuple out
 * of a nested array — a pointer chase plus destructuring — costs several times
 * the relaxation it feeds. Keeping this flat is the difference between a ~13ms
 * and a ~95ms bake on the fixture map.
 */
const SKY_EDGE_STRIDE = 4;
const SKY_EDGES = new Float64Array([
  1, 0, 0, 1,
  -1, 0, 0, 1,
  0, 1, 0, 1,
  0, -1, 0, 1,
  0, 0, 1, 1,
  0, 0, -1, 1,
  1, 1, 0, Math.SQRT2,
  1, -1, 0, Math.SQRT2,
  -1, 1, 0, Math.SQRT2,
  -1, -1, 0, Math.SQRT2,
]);
const SKY_EDGE_COUNT = SKY_EDGES.length / SKY_EDGE_STRIDE;

/**
 * Starting queue size as a multiple of the cell count. Relaxation revisits
 * cells, so enqueues are *not* bounded by the domain — the fixture map alone
 * needs ~1.25×. It grows on demand; this only sets how often that happens.
 */
const SKY_QUEUE_HEADROOM = 2;

/**
 * Whether this tile emits at all, memoised per def.
 *
 * {@link tileCanEmitLight} walks every sprite variant and every frame and
 * allocates as it goes, which is fine once per tile and wasteful once per
 * placement. Keyed on the def object rather than the id so an edited catalogue
 * is a new object and simply misses, with the old entry collected behind it.
 */
const canEmitByDef = new WeakMap<TileDef, boolean>();

function canEmit(def: TileDef): boolean {
  let known = canEmitByDef.get(def);
  if (known === undefined) {
    known = tileCanEmitLight(def);
    canEmitByDef.set(def, known);
  }
  return known;
}

function parseHexColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = Number.parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

type Domain = {
  x0: number;
  y0: number;
  z0: number;
  w: number;
  h: number;
  d: number;
};

function idx(dom: Domain, lx: number, ly: number, lz: number): number {
  return lz * dom.w * dom.h + ly * dom.w + lx;
}

/**
 * Mirrors {@link stackOcclusion} — kept local to avoid a lighting↔flood cycle.
 *
 * `opacity` is how much gets past sideways; `seals` is whether the cell has a
 * lid. Two independent facts — see `CellOcclusion` for why they must stay that
 * way.
 */
function stackOcc(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): { opacity: number; seals: boolean } {
  let blockH = 0;
  let seals = false;
  for (const placed of stack) {
    const def = tilesById[placed.tileId];
    if (!def) continue;
    if (resolveLightPassing(def)) continue;
    seals = true;
    blockH += def.height;
  }
  return {
    opacity: Math.min(1, blockH / HEIGHT_PER_LEVEL),
    seals,
  };
}

/** Mirrors {@link emitterCenter} — kept local to avoid a lighting↔flood cycle. */
function emitCenter(
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): { fx: number; fy: number; fz: number } {
  const def = tilesById[stack[stackIndex]?.tileId ?? ""];
  const height = def?.height ?? 0;
  const baseAbs =
    z * HEIGHT_PER_LEVEL + elevationAt(stack, stackIndex, tilesById);
  return {
    fx: x + 0.5,
    fy: y + 0.5,
    fz: (baseAbs + height / 2) / HEIGHT_PER_LEVEL,
  };
}

type EmitterSeed = {
  /** Fractional emit position. */
  x: number;
  y: number;
  z: number;
  lx: number;
  ly: number;
  lz: number;
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
};

/** Dense Amanatides–Woo; endpoints excluded. */
function denseRayTransmission(
  dom: Domain,
  opacity: Float32Array,
  seals: Uint8Array,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  let x = x0;
  let y = y0;
  let z = z0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const stepX = Math.sign(dx) || 0;
  const stepY = Math.sign(dy) || 0;
  const stepZ = Math.sign(dz) || 0;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const absDz = Math.abs(dz);
  const tDeltaX = absDx === 0 ? Number.POSITIVE_INFINITY : 1 / absDx;
  const tDeltaY = absDy === 0 ? Number.POSITIVE_INFINITY : 1 / absDy;
  const tDeltaZ = absDz === 0 ? Number.POSITIVE_INFINITY : 1 / absDz;
  let tMaxX = absDx === 0 ? Number.POSITIVE_INFINITY : tDeltaX * 0.5;
  let tMaxY = absDy === 0 ? Number.POSITIVE_INFINITY : tDeltaY * 0.5;
  let tMaxZ = absDz === 0 ? Number.POSITIVE_INFINITY : tDeltaZ * 0.5;
  let transmission = 1;
  const maxSteps = absDx + absDy + absDz;
  for (let s = 0; s < maxSteps; s++) {
    let movedZ = false;
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        x += stepX;
        tMaxX += tDeltaX;
      } else {
        z += stepZ;
        tMaxZ += tDeltaZ;
        movedZ = true;
      }
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      tMaxZ += tDeltaZ;
      movedZ = true;
    }
    if (x === x1 && y === y1 && z === z1) break;
    const lx = x - dom.x0;
    const ly = y - dom.y0;
    const lz = z - dom.z0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= dom.w || ly >= dom.h || lz >= dom.d) {
      continue;
    }
    const i = idx(dom, lx, ly, lz);
    // Anything solid hard-seals vertical passage, however short it stands.
    if (movedZ && seals[i]!) {
      if (stepZ < 0 && z1 < z) return 0;
      if (stepZ > 0 && z1 > z) return 0;
    }
    const op = opacity[i]!;
    if (op > 0) {
      transmission *= 1 - op;
      if (transmission < TRANSMISSION_EPSILON) return 0;
    }
  }
  return transmission;
}

/**
 * Explicit bake domain, inclusive on every axis.
 *
 * Without one the domain is derived from wherever the given map has content,
 * which is fine for a whole map but wrong for a windowed bake: an empty
 * neighbourhood shrinks the domain inside the window, and the caller silently
 * gets no plane for the cells it asked about. State the domain and empty space
 * still bakes — as void, black, which is what empty space with nothing under it
 * looks like.
 */
export type FloodDomain = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
};

type FloodCell = { x: number; y: number; z: number; stack: PlacedTile[] };

/**
 * Emitters among `cells` whose light follows the animation clock.
 *
 * A pass of its own rather than a branch inside the emitter gather, and the
 * separation is load-bearing rather than tidy: folding these few lines into
 * that loop left the whole bake compiling to ~29ms instead of ~23ms on some
 * runs and not others. A second walk over the cells costs a fraction of a
 * millisecond and leaves the hot loop exactly as it was.
 *
 * Tiles the caller paints dynamically are skipped for the same reason they are
 * skipped as emitters: their light is not in this bake, so it cannot stale it.
 */
function collectAnimatedEmitters(
  cells: readonly FloodCell[],
  tilesById: Record<string, TileDef>,
  omitLightTileIds: ReadonlySet<string> | undefined,
): AnimatedEmitter[] {
  const varying = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (tileLightVaries(def)) varying.add(def.id);
  }
  // Nothing in this world flickers — the overwhelmingly common case, and it
  // costs one branch rather than a walk over every placed tile.
  if (!varying.size) return [];

  const out: AnimatedEmitter[] = [];
  for (const c of cells) {
    for (const placed of c.stack) {
      if (!varying.has(placed.tileId)) continue;
      if (omitLightTileIds?.has(placed.tileId)) continue;
      const def = tilesById[placed.tileId];
      if (!def) continue;
      out.push({
        tileId: def.id,
        x: c.x,
        y: c.y,
        radius: maxLightRadius(def),
      });
    }
  }
  return out;
}

function collectLevelCells(chunk: ChunkCells, z: number, into: FloodCell[]) {
  // `for..in` rather than `Object.entries`, which builds an array of `[key,
  // value]` pairs — one throwaway array per cell — before the first one is read.
  for (const ck in chunk) {
    const stack = chunk[ck]!;
    if (!stack.length) continue;
    const { x, y } = parseCoordKey(ck);
    into.push({ x, y, z, stack });
  }
}

/**
 * Cells of a level inside `rect`, reached through the chunks that overlap it.
 *
 * The alternative — asking `getStack` for every coordinate in the rect — costs
 * two key strings per probe and visits far more empty cells than full ones: on
 * a windowed bake that was 34k lookups to hand over 3k cells, and measured as
 * expensive as the flood it fed. Addressing the chunks instead makes the gather
 * proportional to content rather than to area.
 */
function collectLevelCellsIn(
  map: MapFile,
  z: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  into: FloodCell[],
) {
  const level = map.levels[levelKey(z)];
  if (!level) return;
  for (let cy = chunkIndexOf(rect.y0); cy <= chunkIndexOf(rect.y1); cy++) {
    for (let cx = chunkIndexOf(rect.x0); cx <= chunkIndexOf(rect.x1); cx++) {
      const chunk = level[chunkKeyAt(cx, cy)];
      if (!chunk) continue;
      // Edge chunks straddle the rect, so cells still need the bounds test.
      for (const ck in chunk) {
        const stack = chunk[ck]!;
        if (!stack.length) continue;
        const { x, y } = parseCoordKey(ck);
        if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) continue;
        into.push({ x, y, z, stack });
      }
    }
  }
}

/**
 * Hybrid bake: Euclidean-cost sky flood + circular block emitters.
 *
 * A cell with nothing at or below it in its column is *void*: it bakes black,
 * the sky flood stops at it, and block light never lands in it. Daylight is
 * seeded onto the top of every column regardless, so a lone floor three levels
 * down is as sunlit as the ground — what changes is only that the shaft ends
 * where the tiles end instead of running on to the bottom of the world.
 *
 * Ambient is *not* applied here — sky factor and block light are stored
 * separately so time of day can re-tint without rebaking. Compose with
 * {@link composeLightGrid}.
 *
 * Pass `domain` to bake a fixed region — cells outside it are still read for
 * occlusion and emitters, so a caller wanting a correct window must hand in a
 * map cropped no tighter than the window plus {@link MAX_LIGHT_LEVEL}. That is
 * enough for a block emitter as well as for sky, but only because
 * `clampTileLight` holds every authored radius to the same number.
 *
 * `timeMs` is the animation clock: emitters are read from the frame live at
 * that moment, so a torch that flickers bakes the light it is showing rather
 * than the light it showed on frame 0. Callers that hold the result across
 * frames must also read {@link RawLightGrid.animated} — that is the list of
 * emitters this bake goes stale with.
 */
export function computeLightingFlood(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides?: ReadonlyArray<EmitterOverride>,
  omitLightTileIds?: ReadonlySet<string>,
  domain?: FloodDomain,
  timeMs = 0,
): RawLightGrid {
  const levels = new Map<number, RawLevelLight>();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const cells: FloodCell[] = [];

  // Walked chunk by chunk rather than via listCoords: the bake reads every cell
  // and listCoords would allocate a wrapper object per cell to hand them over.
  //
  // A domain also bounds the *gather*, not just the output. Without that the
  // cost of a windowed bake tracks the whole map — the same cliff the chunk
  // cache exists to avoid, one level down. Cells outside the domain cannot
  // reach into it: the caller pads by MAX_LIGHT_LEVEL, which no emitter radius
  // exceeds — `clampTileLight` is what makes that true — so dropping them is
  // exact rather than an approximation.
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    if (domain) {
      collectLevelCellsIn(map, z, domain, cells);
      continue;
    }
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const chunk of Object.values(level)) {
      collectLevelCells(chunk, z, cells);
    }
  }
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }

  // An explicit domain wins outright: empty space inside it must still bake,
  // and content outside it must not stretch it.
  if (domain) {
    minX = domain.x0;
    minY = domain.y0;
    maxX = domain.x1;
    maxY = domain.y1;
    minZ = domain.z0;
    maxZ = domain.z1;
  } else if (!Number.isFinite(minX)) {
    return { levels, animated: [] };
  }

  const animated = collectAnimatedEmitters(cells, tilesById, omitLightTileIds);

  const overrideByCell = new Map<string, EmitterOverride>();
  if (overrides) {
    for (const o of overrides) {
      overrideByCell.set(`${o.z}:${coordKey(o.x, o.y)}`, o);
    }
  }

  const emitters: EmitterSeed[] = [];
  let maxRadius = 0;
  for (const c of cells) {
    // Only built when there is something to find. The key is a fresh string per
    // cell, and this loop runs over every stack in the domain — on a windowed
    // bake with no overrides at all that was thousands of throwaway strings to
    // probe an empty map.
    const ov = overrideByCell.size
      ? overrideByCell.get(`${c.z}:${coordKey(c.x, c.y)}`)
      : undefined;
    for (let si = 0; si < c.stack.length; si++) {
      const placed = c.stack[si]!;
      if (omitLightTileIds?.has(placed.tileId)) continue;
      const def = tilesById[placed.tileId];
      if (!def) continue;
      // Asked of the tile before the placement, because almost nothing emits:
      // `resolveLight` has to pick the variant and the frame before it can say
      // no, and it was being made to say no for every wall and floor tile in
      // the domain. Whether a tile *can* emit is a property of the def alone,
      // so it is answered once per catalogue rather than once per placement.
      if (!canEmit(def)) continue;
      const light = resolveLight(
        def,
        {
          map,
          x: c.x,
          y: c.y,
          z: c.z,
          direction: placed.direction,
        },
        timeMs,
      );
      if (!light) continue;
      const [cr, cg, cb] = parseHexColor(light.color);
      const center = emitCenter(c.x, c.y, c.z, c.stack, si, tilesById);
      const ex = ov?.fx ?? center.fx;
      const ey = ov?.fy ?? center.fy;
      const ez = ov?.fz ?? center.fz;
      emitters.push({
        x: ex,
        y: ey,
        z: ez,
        lx: c.x,
        ly: c.y,
        lz: c.z,
        radius: light.radius,
        intensity: light.intensity,
        r: cr,
        g: cg,
        b: cb,
      });
      if (light.radius > maxRadius) maxRadius = light.radius;
      if (domain) continue;
      // Grow to fit each emitter's sphere. Skipped under an explicit domain —
      // there the caller has already sized the region, and a torch just
      // outside it should light its way in, not enlarge what gets baked.
      const rx = Math.ceil(light.radius);
      if (ex - rx < minX) minX = Math.floor(ex - rx);
      if (ey - rx < minY) minY = Math.floor(ey - rx);
      if (ex + rx > maxX) maxX = Math.ceil(ex + rx);
      if (ey + rx > maxY) maxY = Math.ceil(ey + rx);
      if (ez - rx < minZ) minZ = Math.floor(ez - rx);
      if (ez + rx > maxZ) maxZ = Math.ceil(ez + rx);
    }
  }

  // Derived domains get a margin so emitter spheres and sky spill are not
  // clipped at the map's edge. An explicit one is taken as given.
  const pad = domain ? 0 : Math.max(1, Math.ceil(maxRadius));
  const dom: Domain = {
    x0: minX - pad,
    y0: minY - pad,
    z0: domain ? domain.z0 : Math.max(MIN_LEVEL, minZ - 1),
    w: maxX - minX + 1 + pad * 2,
    h: maxY - minY + 1 + pad * 2,
    d: 0,
  };
  const zTop = domain ? domain.z1 : Math.min(MAX_LEVEL, maxZ + 1);
  dom.d = zTop - dom.z0 + 1;

  const n = dom.w * dom.h * dom.d;
  const opacity = new Float32Array(n);
  const seals = new Uint8Array(n);
  const sky = new Float32Array(n);
  const blockR = new Float32Array(n);
  const blockG = new Float32Array(n);
  const blockB = new Float32Array(n);

  for (const c of cells) {
    const lx = c.x - dom.x0;
    const ly = c.y - dom.y0;
    const lz = c.z - dom.z0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= dom.w || ly >= dom.h || lz >= dom.d) {
      continue;
    }
    const o = stackOcc(c.stack, tilesById);
    const i = idx(dom, lx, ly, lz);
    opacity[i] = o.opacity;
    seals[i] = o.seals ? 1 : 0;
  }

  const slice = dom.w * dom.h;

  // Void: a cell with nothing at or below it in its column, on any level the
  // map has — not only the levels being baked. Past the map's edge, under a
  // bridge, beneath a pond authored over nothing. It bakes black, the sky
  // flood does not pass through it, and no block light lands in it.
  //
  // What it exists to stop: the shaft used to run down every empty column to
  // the bottom of the world and come back *sideways* under the floor, so a
  // basement beside the map's edge was lit by daylight and followed the hour.
  // Daylight still lands on the top of every column exactly as before — the
  // seed below paints down to the first seal, wherever that is — this only
  // ends the column where the tiles end.
  //
  // `cells` was gathered on every level, so a column's lowest tile is known
  // even when it sits under the domain's floor.
  const lowestTileZ = new Int32Array(slice).fill(NO_TILE_IN_COLUMN);
  for (const c of cells) {
    const lx = c.x - dom.x0;
    const ly = c.y - dom.y0;
    if (lx < 0 || ly < 0 || lx >= dom.w || ly >= dom.h) continue;
    const col = ly * dom.w + lx;
    if (c.z < lowestTileZ[col]!) lowestTileZ[col] = c.z;
  }
  const isVoid = new Uint8Array(n);
  for (let col = 0; col < slice; col++) {
    const voidDepth = Math.min(dom.d, lowestTileZ[col]! - dom.z0);
    for (let lz = 0; lz < voidDepth; lz++) isVoid[col + lz * slice] = 1;
  }

  // Sky column seed. Every cell still receives the shaft that reaches its top —
  // otherwise outdoor bricks bake black — and anything solid in the cell then
  // ends the shaft, whether that is a floor, a bush, or a wall. Height governs
  // what gets past sideways and has no say here. Flood spreads through
  // non-full cells.
  //
  // The seed also records a heightmap, `fullFrom`: the lowest local z in each
  // column whose cell still has the whole shaft. The shaft only ever decreases
  // on the way down and a cell is painted before it attenuates, so the cells
  // holding {@link MAX_LIGHT_LEVEL} are exactly the run from `fullFrom` to the
  // top of the domain. That fact is what the frontier seeding below rests on.
  //
  // Void is only ever the bottom of a column, so reaching it ends the walk. A
  // column that is void from the top holds the shaft nowhere, so it neither
  // seeds itself nor raises a neighbour's frontier — nothing can push into it.
  const fullFrom = new Int32Array(slice);
  for (let ly = 0; ly < dom.h; ly++) {
    for (let lx = 0; lx < dom.w; lx++) {
      let shaft = MAX_LIGHT_LEVEL;
      let full = FULL_SHAFT_NOWHERE;
      for (let lz = dom.d - 1; lz >= 0; lz--) {
        const i = idx(dom, lx, ly, lz);
        if (isVoid[i]!) break;
        sky[i] = shaft;
        if (shaft >= MAX_LIGHT_LEVEL) full = lz;
        if (seals[i]!) shaft = 0;
      }
      fullFrom[ly * dom.w + lx] = full;
    }
  }

  // Sky spread with Euclidean edge costs (rounder than Manhattan diamonds).
  // Full opaques are not enqueued — their shaft paint must not spill through
  // walls. Half-blocks participate and decay light by half on entry.
  // Must grow: a typed-array write past the end is a silent no-op, so an
  // undersized queue drops propagations and bakes those cells too dark.
  let skyQ = new Int32Array(n * SKY_QUEUE_HEADROOM);
  let skyLen = 0;

  // Only the frontier is seeded, not every lit cell.
  //
  // Every step costs at least 1 and MAX_LIGHT_LEVEL is the ceiling, so a cell
  // holding the full shaft can never raise a neighbour that is also holding it.
  // Queueing open sky was therefore queueing work that was guaranteed to fail:
  // on the fixture map 78% of cells sat at the ceiling, each dequeued to relax
  // ten neighbours already at it, and that alone was most of the bake.
  //
  // A cell can be skipped when every one of its neighbours is at the ceiling
  // too. `fullFrom` answers that per column without touching a single
  // neighbouring cell: the eight lateral neighbours are short of the ceiling at
  // this height exactly when their column's own `fullFrom` sits above it, and
  // the cell below is exactly when it is under this column's. The highest of
  // those is where the open sky stops being able to do anything, so scanning
  // below it is the whole of the work — the interior is never visited at all.
  //
  // Skipped conservatively rather than exactly: a neighbouring column whose
  // `fullFrom` rests on an opaque cell seeds a few cells that turn out to have
  // nowhere to push. Cheap, and it keeps the rule one line.
  for (let ly = 0; ly < dom.h; ly++) {
    for (let lx = 0; lx < dom.w; lx++) {
      const col = ly * dom.w + lx;
      let frontier = fullFrom[col]! + 1;
      const ny1 = Math.min(dom.h - 1, ly + 1);
      const nx1 = Math.min(dom.w - 1, lx + 1);
      for (let ny = Math.max(0, ly - 1); ny <= ny1; ny++) {
        for (let nx = Math.max(0, lx - 1); nx <= nx1; nx++) {
          const nf = fullFrom[ny * dom.w + nx]!;
          if (nf > frontier) frontier = nf;
        }
      }
      if (frontier > dom.d) frontier = dom.d;
      for (let lz = 0; lz < frontier; lz++) {
        const i = idx(dom, lx, ly, lz);
        if (opacity[i]! >= 1) continue;
        if (sky[i]! > 0.5) skyQ[skyLen++] = i;
      }
    }
  }
  let skyHead = 0;
  while (skyHead < skyLen) {
    const i = skyQ[skyHead++]!;
    const s = sky[i]!;
    if (s <= 0.5) continue;
    const lz = (i / slice) | 0;
    const rem = i - lz * slice;
    const ly = (rem / dom.w) | 0;
    const lx = rem - ly * dom.w;
    for (let ei = 0; ei < SKY_EDGE_COUNT; ei++) {
      const e = ei * SKY_EDGE_STRIDE;
      const dx = SKY_EDGES[e]!;
      const dy = SKY_EDGES[e + 1]!;
      const dz = SKY_EDGES[e + 2]!;
      const cost = SKY_EDGES[e + 3]!;
      const tx = lx + dx;
      const ty = ly + dy;
      const tz = lz + dz;
      if (tx < 0 || ty < 0 || tz < 0 || tx >= dom.w || ty >= dom.h || tz >= dom.d) {
        continue;
      }
      const j = idx(dom, tx, ty, tz);
      const topOp = opacity[j]!;
      if (topOp >= 1) continue;
      if (isVoid[j]!) continue;
      if (dz !== 0) {
        // The floor between the two cells decides this edge, and nothing
        // standing on that floor gets a vote: a lid is a lid whether it is
        // bare grass or grass with a sign on it. Reading `opacity` here as
        // well is what let daylight down into every sealed room under a bush.
        if (seals[dz > 0 ? j : i]!) continue;
      }
      let next = s - cost;
      if (topOp > 0) next *= 1 - topOp;
      if (next > sky[j]!) {
        sky[j] = next;
        if (skyLen === skyQ.length) {
          const grown = new Int32Array(skyQ.length * 2);
          grown.set(skyQ);
          skyQ = grown;
        }
        skyQ[skyLen++] = j;
      }
    }
  }

  // Circular block lights (spherical falloff + dense ray occlusion).
  for (const e of emitters) {
    const rCells = Math.ceil(e.radius);
    const sx = Math.floor(e.x);
    const sy = Math.floor(e.y);
    const sz = Math.floor(e.z);
    const selfLx = e.lx - dom.x0;
    const selfLy = e.ly - dom.y0;
    const selfLz = e.lz - dom.z0;
    let savedSelfOp = 0;
    let savedSelfSeal = 0;
    let hadSelf = false;
    if (
      selfLx >= 0 &&
      selfLy >= 0 &&
      selfLz >= 0 &&
      selfLx < dom.w &&
      selfLy < dom.h &&
      selfLz < dom.d
    ) {
      const si = idx(dom, selfLx, selfLy, selfLz);
      savedSelfOp = opacity[si]!;
      savedSelfSeal = seals[si]!;
      opacity[si] = 0;
      seals[si] = 0;
      hadSelf = true;
    }

    const zLo = Math.floor(e.z) - rCells;
    const zHi = Math.ceil(e.z) + rCells;
    const yLo = Math.floor(e.y) - rCells;
    const yHi = Math.ceil(e.y) + rCells;
    const xLo = Math.floor(e.x) - rCells;
    const xHi = Math.ceil(e.x) + rCells;

    for (let tz = zLo; tz <= zHi; tz++) {
      for (let ty = yLo; ty <= yHi; ty++) {
        for (let tx = xLo; tx <= xHi; tx++) {
          const lx = tx - dom.x0;
          const ly = ty - dom.y0;
          const lz = tz - dom.z0;
          if (lx < 0 || ly < 0 || lz < 0 || lx >= dom.w || ly >= dom.h || lz >= dom.d) {
            continue;
          }
          const dx = tx - e.x;
          const dy = ty - e.y;
          const dz = tz - e.z;
          const dist = Math.sqrt(
            dx * dx + dy * dy + (dz * VERTICAL_FALLOFF) * (dz * VERTICAL_FALLOFF),
          );
          if (dist > e.radius) continue;

          const i = idx(dom, lx, ly, lz);
          const isSelf = tx === e.lx && ty === e.ly && tz === e.lz;
          if (!isSelf) {
            if (opacity[i]! >= 1) continue;
            // Nothing lands in the void, though the ray still crosses it: a
            // torch lights the far side of a chasm and not the drop.
            if (isVoid[i]!) continue;
            // A cell with a lid refuses light climbing from below.
            if (tz > sz && seals[i]!) continue;
          }

          let transmission = 1;
          if (!isSelf && dist > 0) {
            transmission = denseRayTransmission(
              dom,
              opacity,
              seals,
              sx,
              sy,
              sz,
              tx,
              ty,
              tz,
            );
            if (transmission < TRANSMISSION_EPSILON) continue;
          }

          const t = 1 - dist / e.radius;
          const atten = t * t * e.intensity * transmission;
          if (atten < TRANSMISSION_EPSILON) continue;
          const br = e.r * atten;
          const bg = e.g * atten;
          const bb = e.b * atten;
          if (br > blockR[i]!) blockR[i] = br;
          if (bg > blockG[i]!) blockG[i] = bg;
          if (bb > blockB[i]!) blockB[i] = bb;
        }
      }
    }

    if (hadSelf) {
      const si = idx(dom, selfLx, selfLy, selfLz);
      opacity[si] = savedSelfOp;
      seals[si] = savedSelfSeal;
    }
  }

  for (let lz = 0; lz < dom.d; lz++) {
    const z = dom.z0 + lz;
    const nCells = dom.w * dom.h;
    const skyOut = new Uint8Array(nCells);
    const blockOut = new Uint8Array(nCells * 3);
    for (let ly = 0; ly < dom.h; ly++) {
      for (let lx = 0; lx < dom.w; lx++) {
        const i = idx(dom, lx, ly, lz);
        const ci = ly * dom.w + lx;
        const pi = ci * 3;
        const sk = Math.min(1, sky[i]! / MAX_LIGHT_LEVEL);
        const br = blockR[i]!;
        const bg = blockG[i]!;
        const bb = blockB[i]!;
        if (opacity[i]! >= 1) {
          // Solid cells: keep block light when present; otherwise leave sky so
          // buried/sealed surfaces still pick up ambient tint. Encoding sky=0
          // when block wins keeps compose ambient-free (`sky*amb + block`).
          if (br + bg + bb > 0.01) {
            skyOut[ci] = 0;
            blockOut[pi] = Math.round(Math.min(1, br) * 255);
            blockOut[pi + 1] = Math.round(Math.min(1, bg) * 255);
            blockOut[pi + 2] = Math.round(Math.min(1, bb) * 255);
          } else {
            skyOut[ci] = Math.round(sk * 255);
          }
          continue;
        }
        skyOut[ci] = Math.round(sk * 255);
        blockOut[pi] = Math.round(Math.min(1, br) * 255);
        blockOut[pi + 1] = Math.round(Math.min(1, bg) * 255);
        blockOut[pi + 2] = Math.round(Math.min(1, bb) * 255);
      }
    }
    levels.set(z, {
      x0: dom.x0,
      y0: dom.y0,
      w: dom.w,
      h: dom.h,
      sky: skyOut,
      block: blockOut,
    });
  }

  return { levels, animated };
}
