import type { MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
  resolveLightPassing,
} from "./types";
import { elevationAt } from "./mapData";
import { computeLightingFlood, MAX_LIGHT_LEVEL } from "./lightingFlood";

export { MAX_LIGHT_LEVEL };

/** 1 level of Z equals 1 cell of XY for spherical distance. */
export const VERTICAL_FALLOFF = 1;

/** Below this transmission, treat the ray as fully blocked. */
const TRANSMISSION_EPSILON = 1e-3;

/**
 * How far sky-exposed cells spilled under the old emitter model.
 * @deprecated Flood fill uses {@link MAX_LIGHT_LEVEL} neighbor decay instead.
 */
export const SKY_SPILL_RADIUS = 8;

export type TimeOfDay = "day" | "dusk" | "night";

export const AMBIENT_PRESETS: Record<TimeOfDay, [number, number, number]> = {
  day: [1, 1, 1],
  dusk: [0.55, 0.4, 0.3],
  night: [0.04, 0.05, 0.1],
};

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
 * Fractional cell-space emit position for a lit tile: XY at the cell centre,
 * Z at the tile's vertical centre (stack base elevation + half its height).
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
  return {
    fx: x + 0.5,
    fy: y + 0.5,
    fz: (baseAbs + height / 2) / HEIGHT_PER_LEVEL,
  };
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
  occlusion: Map<string, CellOcclusion>,
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

  const selfKey = cellKey(e.lx, e.ly, e.lz);
  const savedSelfOcc = occlusion.get(selfKey);
  occlusion.delete(selfKey);

  for (let tz = zLo; tz <= zHi; tz++) {
    const floats = floatsByZ.get(tz);
    if (!floats) continue;
    for (let ty = yLo; ty <= yHi; ty++) {
      for (let tx = xLo; tx <= xHi; tx++) {
        const dx = tx - e.x;
        const dy = ty - e.y;
        const dz = tz - e.z;
        const dist = Math.sqrt(
          dx * dx + dy * dy + (dz * VERTICAL_FALLOFF) * (dz * VERTICAL_FALLOFF),
        );
        if (dist > e.radius) continue;

        const isSelf = tx === e.lx && ty === e.ly && tz === e.lz;
        const target = occlusion.get(cellKey(tx, ty, tz));

        if (!isSelf) {
          if (target && target.opacity >= 1) continue;
          // Height-0 floors refuse light climbing from below.
          if (
            tz > sz &&
            target?.sealsLevel &&
            (target.opacity ?? 0) < TRANSMISSION_EPSILON
          ) {
            continue;
          }
        }

        let transmission = 1;
        if (!isSelf && dist > 0) {
          transmission = rayTransmission(sx, sy, sz, tx, ty, tz, occlusion);
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

  if (savedSelfOcc) occlusion.set(selfKey, savedSelfOcc);
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
  return computeLightingFlood(
    map,
    tilesById,
    ambient,
    overrides,
    omitLightTileIds,
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

/**
 * Add-only overlay for emitters that were omitted from the static bake
 * (e.g. the player). No subtract — `base` must not already include them.
 */
export function overlayEmitterOverrides(
  base: LightGrid,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
): LightGrid {
  if (!overrides.length) return cloneLightGrid(base);

  const overrideByCell = new Map<string, EmitterOverride>();
  for (const o of overrides) {
    overrideByCell.set(cellKey(o.x, o.y, o.z), o);
  }

  const occlusion = new Map<string, CellOcclusion>();
  const emitters: Emitter[] = [];

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const [ck, stack] of Object.entries(level)) {
      if (!stack.length) continue;
      const { x, y } = parseCoordKey(ck);
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, z), occ);
      }

      const ov = overrideByCell.get(cellKey(x, y, z));
      if (!ov) continue;

      for (const placed of stack) {
        const def = tilesById[placed.tileId];
        if (!def?.light) continue;
        if (!(def.light.radius > 0) || !(def.light.intensity > 0)) continue;
        const [cr, cg, cb] = parseHexColor(def.light.color);
        emitters.push({
          x: ov.fx,
          y: ov.fy,
          z: ov.fz,
          lx: x,
          ly: y,
          lz: z,
          radius: def.light.radius,
          intensity: def.light.intensity,
          r: cr,
          g: cg,
          b: cb,
        });
      }
    }
  }

  if (!emitters.length) return cloneLightGrid(base);

  const out = cloneLightGrid(base);
  const floatsByZ = new Map<number, Float32Array>();
  let x0 = 0;
  let y0 = 0;
  let w = 0;
  let h = 0;

  for (const [z, level] of out.levels) {
    x0 = level.x0;
    y0 = level.y0;
    w = level.w;
    h = level.h;
    const floats = new Float32Array(level.rgb.length);
    for (let i = 0; i < level.rgb.length; i++) {
      floats[i] = level.rgb[i]! / 255;
    }
    floatsByZ.set(z, floats);
  }

  for (const e of emitters) {
    castEmitter(e, occlusion, floatsByZ, x0, y0, w, h);
  }

  for (const [z, floats] of floatsByZ) {
    const level = out.levels.get(z)!;
    for (let i = 0; i < floats.length; i++) {
      const v = floats[i]!;
      level.rgb[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
  }

  return out;
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
    for (const [ck, stack] of Object.entries(level)) {
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
