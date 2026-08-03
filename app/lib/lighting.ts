import type { MapFile, PlacedTile, TileDef } from "./types";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
  resolveLightPassing,
} from "./types";

/** 1 level of Z equals 1 cell of XY for spherical distance. */
export const VERTICAL_FALLOFF = 1;

/** Below this transmission, treat the ray as fully blocked. */
const TRANSMISSION_EPSILON = 1e-3;

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
   * 0 = open, 1 = sealed by any positive-height blocker.
   */
  opacity: number;
  /** Any non-light-passing tile — seals vertical travel between floors. */
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
 * How much a stack occludes light.
 * - Light-passing tiles (water) ignored.
 * - Any positive blocking height fully seals the cell (no partial seep through
 *   half-slabs / plaster). Height 0 floors still seal vertically only.
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
    opacity: blockH > 0 ? 1 : 0,
    sealsLevel,
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

    // Floors seal vertical *passage* past them, not landing on their own level.
    // Descending onto a floor then walking across it (common DDA path) must stay
    // open; only block when the ray's destination is beyond this floor in Z.
    if (movedZ && cell.sealsLevel) {
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
 * Build a per-level RGB light grid from map tile defs + ambient.
 * Pure / deterministic — no Three.js.
 *
 * Optional `overrides` relocate emitters from their map cell to a fractional
 * cell-space position (e.g. mid-walk) so cast light tracks sprite motion.
 */
export function computeLighting(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ambient: [number, number, number],
  overrides?: ReadonlyArray<EmitterOverride>,
): LightGrid {
  const overrideByCell = new Map<string, EmitterOverride>();
  if (overrides) {
    for (const o of overrides) {
      overrideByCell.set(cellKey(o.x, o.y, o.z), o);
    }
  }

  const occlusion = new Map<string, CellOcclusion>();
  const emitters: Emitter[] = [];
  const emitterCells = new Set<string>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxRadius = 0;
  const occupiedZ = new Set<number>();

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const [ck, stack] of Object.entries(level)) {
      if (!stack.length) continue;
      const { x, y } = parseCoordKey(ck);
      occupiedZ.add(z);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, z), occ);
      }

      for (const placed of stack) {
        const def = tilesById[placed.tileId];
        if (!def?.light) continue;
        if (!(def.light.radius > 0) || !(def.light.intensity > 0)) continue;
        const [cr, cg, cb] = parseHexColor(def.light.color);
        const ov = overrideByCell.get(cellKey(x, y, z));
        emitters.push({
          x: ov?.fx ?? x,
          y: ov?.fy ?? y,
          z: ov?.fz ?? z,
          lx: x,
          ly: y,
          lz: z,
          radius: def.light.radius,
          intensity: def.light.intensity,
          r: cr,
          g: cg,
          b: cb,
        });
        emitterCells.add(cellKey(x, y, z));
        if (def.light.radius > maxRadius) maxRadius = def.light.radius;
      }
    }
  }

  const levels = new Map<number, LevelLightMap>();

  if (!Number.isFinite(minX)) {
    return { levels };
  }

  const pad = Math.ceil(maxRadius);
  const x0 = minX - pad;
  const y0 = minY - pad;
  const x1 = maxX + pad;
  const y1 = maxY + pad;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;

  let zMin = MIN_LEVEL;
  let zMax = MAX_LEVEL;
  if (emitters.length > 0) {
    zMin = Math.max(
      MIN_LEVEL,
      Math.min(
        ...emitters.map((e) => Math.floor(e.z) - Math.ceil(e.radius)),
      ),
    );
    zMax = Math.min(
      MAX_LEVEL,
      Math.max(
        ...emitters.map((e) => Math.ceil(e.z) + Math.ceil(e.radius)),
      ),
    );
  }
  for (const z of occupiedZ) {
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }

  const floatsByZ = new Map<number, Float32Array>();
  for (let z = zMin; z <= zMax; z++) {
    const floats = new Float32Array(w * h * 3);
    for (let i = 0; i < floats.length; i += 3) {
      floats[i] = ambient[0];
      floats[i + 1] = ambient[1];
      floats[i + 2] = ambient[2];
    }
    floatsByZ.set(z, floats);
  }

  for (const e of emitters) {
    const rCells = Math.ceil(e.radius);
    const sx = Math.round(e.x);
    const sy = Math.round(e.y);
    const sz = Math.round(e.z);
    const zLo = Math.floor(e.z) - rCells;
    const zHi = Math.ceil(e.z) + rCells;
    const yLo = Math.floor(e.y) - rCells;
    const yHi = Math.ceil(e.y) + rCells;
    const xLo = Math.floor(e.x) - rCells;
    const xHi = Math.ceil(e.x) + rCells;

    // An emitter must never occlude its own light — including when the emit
    // position has lerped away and rays pass back through the logical cell.
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

          // Solids stay dark — except an emitter's own cell (self-lit).
          // Floors (sealsLevel, opacity 0) accept light from above but
          // refuse light climbing up from below. Light still cannot
          // pass *through* a floor — rayTransmission seals on real Z steps.
          if (!isSelf) {
            if (target && target.opacity >= 1) continue;
            if (tz > sz && target?.sealsLevel) continue;
          }

          let transmission = 1;
          if (!isSelf && dist > 0) {
            transmission = rayTransmission(
              sx,
              sy,
              sz,
              tx,
              ty,
              tz,
              occlusion,
            );
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

  // Solid cells: force ambient only (no borrowed neighbour glow / filter bleed source).
  // Emitter cells keep their self-lit contribution.
  for (let z = zMin; z <= zMax; z++) {
    const floats = floatsByZ.get(z)!;
    for (const [key, cell] of occlusion) {
      if (cell.opacity < 1) continue;
      if (emitterCells.has(key)) continue;
      const colon = key.indexOf(":");
      if (Number(key.slice(0, colon)) !== z) continue;
      const { x, y } = parseCoordKey(key.slice(colon + 1));
      const lx = x - x0;
      const ly = y - y0;
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
      const i = (ly * w + lx) * 3;
      floats[i] = ambient[0];
      floats[i + 1] = ambient[1];
      floats[i + 2] = ambient[2];
    }
  }

  for (let z = zMin; z <= zMax; z++) {
    const floats = floatsByZ.get(z)!;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < floats.length; i++) {
      const v = floats[i]!;
      rgb[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    levels.set(z, { x0, y0, w, h, rgb });
  }

  return { levels };
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
