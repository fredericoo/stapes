import type { LevelChunks, MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
  resolveLightPassing,
} from "./types";
import { emitterScreenXY } from "./geometry";
import { elevationAt, getStack } from "./mapData";
import { computeLightingFlood, MAX_LIGHT_LEVEL } from "./lightingFlood";
import { resolveLight } from "./tileResolve";

export { MAX_LIGHT_LEVEL };

/** 1 level of Z equals 1 cell of XY for spherical distance. */
export const VERTICAL_FALLOFF = 1;

/**
 * Cells of Y a cell of reach buys — light spreads half as far north-south as
 * it does east-west.
 *
 * A level of climb is drawn one cell up *and* one cell left, so screen Y
 * carries both the world's Y and the world's height. A pool that is round in
 * world space therefore reads as stretched down the screen, and squaring that
 * up is a decision about how the light looks, not about where it is.
 */
export const Y_FALLOFF = 2;

/** Below this transmission, treat the ray as fully blocked. */
const TRANSMISSION_EPSILON = 1e-3;

/**
 * How far sky-exposed cells spilled under the old emitter model.
 * @deprecated Flood fill uses {@link MAX_LIGHT_LEVEL} neighbor decay instead.
 */
export const SKY_SPILL_RADIUS = 8;

export type LevelLightMap = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** RGB triples, length = w * h * 3, row-major from (x0,y0). */
  rgb: Uint8Array;
};

export type LightGrid = {
  levels: Map<number, LevelLightMap>;
};

/**
 * Ambient-free bake: sky factor + block light. Tint with
 * {@link composeLightGrid} so time of day can change without rebaking.
 */
export type RawLevelLight = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Sky factor 0–255 per cell, length w * h. */
  sky: Uint8Array;
  /** Block light RGB 0–255, length w * h * 3. */
  block: Uint8Array;
};

export type RawLightGrid = {
  levels: Map<number, RawLevelLight>;
};

/**
 * A level's light in the exact byte layout the GPU wants: interleaved RGBA with
 * block light in RGB and the sky factor in alpha. Uploaded verbatim, and tinted
 * in the fragment shader against `uAmbient`, so moving the clock costs neither
 * a re-tint nor a re-upload.
 */
export type PackedLevelLight = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Length w * h * 4. */
  rgba: Uint8Array;
};

export type PackedLightGrid = {
  levels: Map<number, PackedLevelLight>;
};

export function clonePackedLightGrid(grid: PackedLightGrid): PackedLightGrid {
  const levels = new Map<number, PackedLevelLight>();
  for (const [z, level] of grid.levels) {
    levels.set(z, { ...level, rgba: new Uint8Array(level.rgba) });
  }
  return { levels };
}

/** Named presets kept for tests — samples from the clock keyframes. */
export const AMBIENT_PRESETS = {
  day: [1, 1, 1] as [number, number, number],
  dusk: [0.55, 0.4, 0.3] as [number, number, number],
  night: [0.04, 0.05, 0.1] as [number, number, number],
};

/** Write `sky * ambient + block` into `rgb` (length sky.length * 3). */
export function composeAmbientRgb(
  sky: Uint8Array,
  block: Uint8Array,
  ambient: [number, number, number],
  rgb: Uint8Array,
): void {
  for (let i = 0, p = 0; i < sky.length; i++, p += 3) {
    const sk = sky[i]! / 255;
    rgb[p] = Math.round(
      Math.min(1, sk * ambient[0] + block[p]! / 255) * 255,
    );
    rgb[p + 1] = Math.round(
      Math.min(1, sk * ambient[1] + block[p + 1]! / 255) * 255,
    );
    rgb[p + 2] = Math.round(
      Math.min(1, sk * ambient[2] + block[p + 2]! / 255) * 255,
    );
  }
}

export function composeLevelLight(
  raw: RawLevelLight,
  ambient: [number, number, number],
): LevelLightMap {
  const rgb = new Uint8Array(raw.w * raw.h * 3);
  composeAmbientRgb(raw.sky, raw.block, ambient, rgb);
  return { x0: raw.x0, y0: raw.y0, w: raw.w, h: raw.h, rgb };
}

export function composeLightGrid(
  raw: RawLightGrid,
  ambient: [number, number, number],
): LightGrid {
  const levels = new Map<number, LevelLightMap>();
  for (const [z, level] of raw.levels) {
    levels.set(z, composeLevelLight(level, ambient));
  }
  return { levels };
}

export type CellOcclusion = {
  /**
   * 0 = open, 1 = fully sealed. Half-height blockers are 0.5
   * (`blockH / HEIGHT_PER_LEVEL`); rays multiply transmission by `(1 - opacity)`.
   */
  opacity: number;
  /**
   * Non-light-passing tiles present. Height-0 floors hard-seal vertical
   * travel; positive-height blockers use {@link opacity} instead.
   */
  sealsLevel: boolean;
};

/**
 * Relocate a map-cell emitter to a fractional cell-space position (walk/fall lerp).
 * `x,y,z` is the logical cell still on the map; `fx,fy,fz` is where light emits from.
 */
export type EmitterOverride = {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
};

type Emitter = {
  /** Fractional emit position (cell space). */
  x: number;
  y: number;
  z: number;
  /** Logical map cell — self-lit / emitterCells. */
  lx: number;
  ly: number;
  lz: number;
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
};

function parseHexColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = Number.parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function cellKey(x: number, y: number, z: number): string {
  return `${z}:${coordKey(x, y)}`;
}

/**
 * True when nothing above `(x,y,z)` seals the vertical shaft to the sky.
 * The cell itself may hold a floor — sunlight lands on it.
 */
export function isSkyExposed(
  x: number,
  y: number,
  z: number,
  occlusion: Map<string, CellOcclusion>,
): boolean {
  for (let zz = z + 1; zz <= MAX_LEVEL; zz++) {
    const cell = occlusion.get(cellKey(x, y, zz));
    if (!cell) continue;
    if (cell.sealsLevel || cell.opacity >= 1) return false;
  }
  return true;
}

/**
 * How much a stack occludes light.
 * - Light-passing tiles (water) ignored.
 * - Blocking height maps to opacity as `min(1, blockH / HEIGHT_PER_LEVEL)` —
 *   half-blocks decay light by half, full blocks seal.
 * - Height 0 floors still hard-seal vertically only (`sealsLevel`, opacity 0).
 */
export function stackOcclusion(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): CellOcclusion {
  let blockH = 0;
  let sealsLevel = false;
  for (const placed of stack) {
    const def = tilesById[placed.tileId];
    if (!def) continue;
    if (resolveLightPassing(def)) continue;
    sealsLevel = true;
    blockH += def.height;
  }
  return {
    opacity: Math.min(1, blockH / HEIGHT_PER_LEVEL),
    sealsLevel,
  };
}

/**
 * Fractional cell-space emit position for a lit tile: Z at the tile's vertical
 * centre (stack base elevation + half its height), XY where that centre is
 * drawn (see {@link emitterScreenXY}).
 */
export function emitterCenter(
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): { fx: number; fy: number; fz: number } {
  const def = tilesById[stack[stackIndex]?.tileId ?? ""];
  const height = def?.height ?? 0;
  const baseAbs = z * HEIGHT_PER_LEVEL + elevationAt(stack, stackIndex, tilesById);
  const fz = (baseAbs + height / 2) / HEIGHT_PER_LEVEL;
  return { ...emitterScreenXY(x, y, z, fz), fz };
}

/**
 * Amanatides & Woo 3D DDA. Returns remaining transmission after intermediate
 * cells (endpoints excluded). Each cell multiplies by (1 - opacity).
 */
export function rayTransmission(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  occlusion: Map<string, CellOcclusion>,
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
  for (let i = 0; i < maxSteps; i++) {
    // Track which axis actually advanced this step — stepZ alone is nonzero for
    // any vertical ray, including during its horizontal DDA moves.
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

    const cell = occlusion.get(cellKey(x, y, z));
    if (!cell) continue;

    // Height-0 floors hard-seal vertical *passage* past them (opacity 0).
    // Positive-height blockers (half/full) use opacity decay instead.
    if (movedZ && cell.sealsLevel && cell.opacity < TRANSMISSION_EPSILON) {
      if (stepZ < 0 && z1 < z) return 0;
      if (stepZ > 0 && z1 > z) return 0;
    }

    if (cell.opacity > 0) {
      transmission *= 1 - cell.opacity;
      if (transmission < TRANSMISSION_EPSILON) return 0;
    }
  }

  return transmission;
}

/** @deprecated Binary wrapper — prefer {@link rayTransmission}. */
export function rayBlocked(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  opaque: Set<string>,
): boolean {
  const occlusion = new Map<string, CellOcclusion>();
  for (const k of opaque) {
    occlusion.set(k, { opacity: 1, sealsLevel: true });
  }
  return rayTransmission(x0, y0, z0, x1, y1, z1, occlusion) < TRANSMISSION_EPSILON;
}

function accumulateAt(
  floats: Float32Array,
  x0: number,
  y0: number,
  w: number,
  h: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
) {
  const lx = x - x0;
  const ly = y - y0;
  if (lx < 0 || ly < 0 || lx >= w || ly >= h) return;
  const i = (ly * w + lx) * 3;
  floats[i]! += r;
  floats[i + 1]! += g;
  floats[i + 2]! += b;
}

/**
 * Cast one emitter into `floatsByZ` (player overlay / dynamic lights).
 * Floors (sealsLevel, opacity 0) accept light from above but refuse light
 * climbing from below. Solids stay dark except the emitter's own cell.
 */
function castEmitter(
  e: Emitter,
  occlusion: DenseOcclusion,
  floatsByZ: Map<number, Float32Array>,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  const rCells = Math.ceil(e.radius);
  const sx = Math.floor(e.x);
  const sy = Math.floor(e.y);
  const sz = Math.floor(e.z);
  const zLo = Math.floor(e.z) - rCells;
  const zHi = Math.ceil(e.z) + rCells;
  const yLo = Math.floor(e.y) - rCells;
  const yHi = Math.ceil(e.y) + rCells;
  const xLo = Math.floor(e.x) - rCells;
  const xHi = Math.ceil(e.x) + rCells;

  // The emitter's own cell must not shadow itself; restored below.
  const selfIndex = denseIndex(occlusion, e.lx, e.ly, e.lz);
  const savedSelfOpacity = selfIndex < 0 ? 0 : occlusion.opacity[selfIndex]!;
  const savedSelfSeals = selfIndex < 0 ? 0 : occlusion.seals[selfIndex]!;
  if (selfIndex >= 0) {
    occlusion.opacity[selfIndex] = 0;
    occlusion.seals[selfIndex] = 0;
  }

  for (let tz = zLo; tz <= zHi; tz++) {
    const floats = floatsByZ.get(tz);
    if (!floats) continue;
    for (let ty = yLo; ty <= yHi; ty++) {
      for (let tx = xLo; tx <= xHi; tx++) {
        const dx = tx - e.x;
        const dy = (ty - e.y) * Y_FALLOFF;
        const dz = (tz - e.z) * VERTICAL_FALLOFF;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > e.radius) continue;

        const isSelf = tx === e.lx && ty === e.ly && tz === e.lz;
        const ti = denseIndex(occlusion, tx, ty, tz);
        const targetOpacity = ti < 0 ? 0 : occlusion.opacity[ti]!;
        const targetSeals = ti < 0 ? 0 : occlusion.seals[ti]!;

        if (!isSelf) {
          if (targetOpacity >= 1) continue;
          // Height-0 floors refuse light climbing from below.
          if (tz > sz && targetSeals && targetOpacity < TRANSMISSION_EPSILON) {
            continue;
          }
        }

        let transmission = 1;
        if (!isSelf && dist > 0) {
          transmission = denseRayTransmission(occlusion, sx, sy, sz, tx, ty, tz);
          if (transmission < TRANSMISSION_EPSILON) continue;
        }

        const t = 1 - dist / e.radius;
        const atten = t * t * e.intensity * transmission;
        if (atten < TRANSMISSION_EPSILON) continue;

        accumulateAt(
          floats,
          x0,
          y0,
          w,
          h,
          tx,
          ty,
          e.r * atten,
          e.g * atten,
          e.b * atten,
        );
      }
    }
  }

  if (selfIndex >= 0) {
    occlusion.opacity[selfIndex] = savedSelfOpacity;
    occlusion.seals[selfIndex] = savedSelfSeals;
  }
}

/**
 * Build a per-level RGB light grid via Minecraft-style sky + block flood fill.
 * Pure / deterministic — no Three.js.
 *
 * `ambient` is the sky colour (time of day) multiplied by the discrete sky level.
 * Optional `overrides` relocate emitters; `omitLightTileIds` skips their bake
 * so a moving player can be overlaid cheaply.
 */
export function computeLighting(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ambient: [number, number, number],
  overrides?: ReadonlyArray<EmitterOverride>,
  omitLightTileIds?: ReadonlySet<string>,
): LightGrid {
  return composeLightGrid(
    computeLightingFlood(map, tilesById, overrides, omitLightTileIds),
    ambient,
  );
}

/**
 * Deep-copy a light grid (new `rgb` buffers). Used so dynamic paint can mutate
 * a snapshot of the static bake without ruining the cache.
 */
export function cloneLightGrid(grid: LightGrid): LightGrid {
  const levels = new Map<number, LevelLightMap>();
  for (const [z, level] of grid.levels) {
    levels.set(z, {
      x0: level.x0,
      y0: level.y0,
      w: level.w,
      h: level.h,
      rgb: new Uint8Array(level.rgb),
    });
  }
  return { levels };
}

/** Cells an emitter set can reach: a rect plus the levels it spans. */
type Reach = { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number };

function emitterReach(emitters: readonly Emitter[]): Reach {
  const r: Reach = {
    x0: Infinity,
    y0: Infinity,
    x1: -Infinity,
    y1: -Infinity,
    z0: Infinity,
    z1: -Infinity,
  };
  for (const e of emitters) {
    const rc = Math.ceil(e.radius);
    r.x0 = Math.min(r.x0, Math.floor(e.x) - rc);
    r.y0 = Math.min(r.y0, Math.floor(e.y) - rc);
    r.x1 = Math.max(r.x1, Math.ceil(e.x) + rc);
    r.y1 = Math.max(r.y1, Math.ceil(e.y) + rc);
    r.z0 = Math.min(r.z0, Math.floor(e.z) - rc);
    r.z1 = Math.max(r.z1, Math.ceil(e.z) + rc);
  }
  return r;
}

/**
 * Emitters at the override cells, found by looking those cells up rather than
 * sweeping the map for them. There is one override in practice — the player —
 * so the old sweep read every cell in the world to find a single tile.
 */
function collectOverrideEmitters(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
): Emitter[] {
  const emitters: Emitter[] = [];
  for (const ov of overrides) {
    const stack = getStack(map, ov.x, ov.y, ov.z);
    if (!stack.length) continue;
    for (const placed of stack) {
      const def = tilesById[placed.tileId];
      if (!def) continue;
      const light = resolveLight(
        def,
        { map, x: ov.x, y: ov.y, z: ov.z, direction: placed.direction },
        0,
      );
      if (!light) continue;
      const [cr, cg, cb] = parseHexColor(light.color);
      emitters.push({
        x: ov.fx,
        y: ov.fy,
        z: ov.fz,
        lx: ov.x,
        ly: ov.y,
        lz: ov.z,
        radius: light.radius,
        intensity: light.intensity,
        r: cr,
        g: cg,
        b: cb,
      });
    }
  }
  return emitters;
}

/**
 * Occluders inside `reach`, as flat arrays indexed off the box.
 *
 * The cast probes a cell per ray step, millions of times a second, and a
 * string-keyed Map turns each of those into a key build plus a hash lookup.
 * Indexing arithmetic on a typed array is the same trick that took the sky
 * flood from ~95ms to ~13ms.
 */
export type DenseOcclusion = {
  reach: Reach;
  w: number;
  h: number;
  d: number;
  /** 0 open, 1 sealed; matches {@link CellOcclusion.opacity}. */
  opacity: Float32Array;
  /** 1 where {@link CellOcclusion.sealsLevel}. */
  seals: Uint8Array;
};

function denseIndex(o: DenseOcclusion, x: number, y: number, z: number): number {
  const lx = x - o.reach.x0;
  const ly = y - o.reach.y0;
  const lz = z - o.reach.z0;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= o.w || ly >= o.h || lz >= o.d) return -1;
  return (lz * o.h + ly) * o.w + lx;
}

function denseOcclusionIn(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  reach: Reach,
): DenseOcclusion {
  const w = reach.x1 - reach.x0 + 1;
  const h = reach.y1 - reach.y0 + 1;
  const d = reach.z1 - reach.z0 + 1;
  const dense: DenseOcclusion = {
    reach,
    w,
    h,
    d,
    opacity: new Float32Array(w * h * d),
    seals: new Uint8Array(w * h * d),
  };

  for (let z = Math.max(MIN_LEVEL, reach.z0); z <= Math.min(MAX_LEVEL, reach.z1); z++) {
    if (!map.levels[levelKey(z)]) continue;
    fillDenseLevel(dense, map, tilesById, z);
  }
  return dense;
}

function fillDenseLevel(
  dense: DenseOcclusion,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  z: number,
) {
  const { reach } = dense;
  for (let y = reach.y0; y <= reach.y1; y++) {
    for (let x = reach.x0; x <= reach.x1; x++) {
      const stack = getStack(map, x, y, z);
      if (!stack.length) continue;
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity <= 0 && !occ.sealsLevel) continue;
      const i = denseIndex(dense, x, y, z);
      if (i < 0) continue;
      dense.opacity[i] = occ.opacity;
      dense.seals[i] = occ.sealsLevel ? 1 : 0;
    }
  }
}

/** {@link rayTransmission} against a {@link DenseOcclusion}. Same maths, no hashing. */
function denseRayTransmission(
  o: DenseOcclusion,
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
  for (let i = 0; i < maxSteps; i++) {
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

    const i2 = denseIndex(o, x, y, z);
    if (i2 < 0) continue;
    const opacity = o.opacity[i2]!;
    const seals = o.seals[i2]!;
    if (!opacity && !seals) continue;

    if (movedZ && seals && opacity < TRANSMISSION_EPSILON) {
      if (stepZ < 0 && z1 < z) return 0;
      if (stepZ > 0 && z1 > z) return 0;
    }
    if (opacity > 0) {
      transmission *= 1 - opacity;
      if (transmission < TRANSMISSION_EPSILON) return 0;
    }
  }
  return transmission;
}

/**
 * A level's colour bytes viewed generically, so the same overlay maths serves
 * both a composed RGB grid and a packed RGBA one whose RGB half is block light.
 */
type ChannelView = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Uint8Array;
  stride: number;
};

/** Lift the reach rect out of a level into float accumulators. */
function readReachFloats(level: ChannelView, reach: Reach, w: number, h: number) {
  const floats = new Float32Array(w * h * 3);
  for (let ly = 0; ly < h; ly++) {
    const sy = reach.y0 + ly - level.y0;
    if (sy < 0 || sy >= level.h) continue;
    for (let lx = 0; lx < w; lx++) {
      const sx = reach.x0 + lx - level.x0;
      if (sx < 0 || sx >= level.w) continue;
      const src = (sy * level.w + sx) * level.stride;
      const dst = (ly * w + lx) * 3;
      floats[dst] = level.data[src]! / 255;
      floats[dst + 1] = level.data[src + 1]! / 255;
      floats[dst + 2] = level.data[src + 2]! / 255;
    }
  }
  return floats;
}

function writeReachFloats(
  level: ChannelView,
  floats: Float32Array,
  reach: Reach,
  w: number,
  h: number,
) {
  const quantise = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  for (let ly = 0; ly < h; ly++) {
    const sy = reach.y0 + ly - level.y0;
    if (sy < 0 || sy >= level.h) continue;
    for (let lx = 0; lx < w; lx++) {
      const sx = reach.x0 + lx - level.x0;
      if (sx < 0 || sx >= level.w) continue;
      const src = (ly * w + lx) * 3;
      const dst = (sy * level.w + sx) * level.stride;
      level.data[dst] = quantise(floats[src]!);
      level.data[dst + 1] = quantise(floats[src + 1]!);
      level.data[dst + 2] = quantise(floats[src + 2]!);
    }
  }
}

function rgbView(level: LevelLightMap): ChannelView {
  return { ...level, data: level.rgb, stride: 3 };
}

function blockView(level: PackedLevelLight): ChannelView {
  return { ...level, data: level.rgba, stride: 4 };
}

/**
 * Paint dynamic emitters into the block channel of a packed grid.
 *
 * The identical cast to {@link overlayEmitterOverrides}, aimed at block light
 * rather than an already-tinted RGB. A dynamic light *is* block light, so this
 * is where it belongs once ambient moved to the shader.
 */
export function overlayEmitterOverridesPacked(
  base: PackedLightGrid,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
): PackedLightGrid {
  if (!overrides.length) return clonePackedLightGrid(base);

  const emitters = collectOverrideEmitters(map, tilesById, overrides);
  if (!emitters.length) return clonePackedLightGrid(base);

  const reach = emitterReach(emitters);
  const occlusion = denseOcclusionIn(map, tilesById, reach);

  const out = clonePackedLightGrid(base);
  const w = reach.x1 - reach.x0 + 1;
  const h = reach.y1 - reach.y0 + 1;

  const floatsByZ = new Map<number, Float32Array>();
  for (let z = reach.z0; z <= reach.z1; z++) {
    const level = out.levels.get(z);
    if (!level) continue;
    floatsByZ.set(z, readReachFloats(blockView(level), reach, w, h));
  }

  for (const e of emitters) {
    castEmitter(e, occlusion, floatsByZ, reach.x0, reach.y0, w, h);
  }

  for (const [z, floats] of floatsByZ) {
    writeReachFloats(blockView(out.levels.get(z)!), floats, reach, w, h);
  }

  return out;
}

/**
 * Add-only overlay for emitters that were omitted from the static bake
 * (e.g. the player). No subtract — `base` must not already include them.
 *
 * Everything here is scoped to the emitters' reach. This runs on every frame a
 * dynamic light moves, so touching anything proportional to the map — or even
 * to the whole window — shows up directly as frame time.
 */
export function overlayEmitterOverrides(
  base: LightGrid,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
): LightGrid {
  if (!overrides.length) return cloneLightGrid(base);

  const emitters = collectOverrideEmitters(map, tilesById, overrides);
  if (!emitters.length) return cloneLightGrid(base);

  const reach = emitterReach(emitters);
  const occlusion = denseOcclusionIn(map, tilesById, reach);

  const out = cloneLightGrid(base);
  const w = reach.x1 - reach.x0 + 1;
  const h = reach.y1 - reach.y0 + 1;

  const floatsByZ = new Map<number, Float32Array>();
  for (let z = reach.z0; z <= reach.z1; z++) {
    const level = out.levels.get(z);
    if (!level) continue;
    floatsByZ.set(z, readReachFloats(rgbView(level), reach, w, h));
  }

  for (const e of emitters) {
    castEmitter(e, occlusion, floatsByZ, reach.x0, reach.y0, w, h);
  }

  for (const [z, floats] of floatsByZ) {
    writeReachFloats(rgbView(out.levels.get(z)!), floats, reach, w, h);
  }

  return out;
}

/** Every (cellKey, stack) on a level, across its chunks. */
function* allCells(
  level: LevelChunks,
): Generator<[string, PlacedTile[]]> {
  for (const chunk of Object.values(level)) {
    yield* Object.entries(chunk);
  }
}

/**
 * Stable key for static lighting: map content excluding tiles whose lights are
 * painted dynamically (player). Moving those tiles alone must not invalidate
 * the sky/torch bake.
 */
export function staticLightingMapKey(
  map: MapFile,
  omitLightTileIds: ReadonlySet<string>,
): string {
  let h = 2166136261;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const [ck, stack] of allCells(level)) {
      if (!stack.length) continue;
      let any = false;
      for (const placed of stack) {
        if (omitLightTileIds.has(placed.tileId)) continue;
        any = true;
        for (let i = 0; i < placed.tileId.length; i++) {
          h ^= placed.tileId.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        if (placed.direction) {
          h ^= placed.direction.charCodeAt(0);
          h = Math.imul(h, 16777619);
        }
      }
      if (!any) continue;
      h ^= z + 1;
      h = Math.imul(h, 16777619);
      for (let i = 0; i < ck.length; i++) {
        h ^= ck.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
    }
  }
  return (h >>> 0).toString(36);
}

export function sampleLevelLight(
  level: LevelLightMap,
  x: number,
  y: number,
): [number, number, number] {
  const lx = x - level.x0;
  const ly = y - level.y0;
  if (lx < 0 || ly < 0 || lx >= level.w || ly >= level.h) {
    return [0, 0, 0];
  }
  const i = (ly * level.w + lx) * 3;
  return [level.rgb[i]! / 255, level.rgb[i + 1]! / 255, level.rgb[i + 2]! / 255];
}
