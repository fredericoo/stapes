/**
 * Hybrid lighting bake:
 * - Sky: column seed + float flood with Euclidean edge costs (rounder than
 *   Manhattan diamonds).
 * - Block/torches: spherical falloff + occlusion DDA (same look as the old bake).
 *
 * Sky flood stays cheap; circular casts only run for the few map emitters.
 */
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
import type { EmitterOverride, LightGrid, LevelLightMap } from "./lighting";

/** Max sky level after column seed. Tune to widen/narrow sky spill. */
export const MAX_LIGHT_LEVEL = 15;

const TRANSMISSION_EPSILON = 1e-3;
const VERTICAL_FALLOFF = 1;

/** 6-face + 4 diagonal (XY) with Euclidean step cost — softens diamond shapes. */
const SKY_EDGES: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, 1],
  [-1, 0, 0, 1],
  [0, 1, 0, 1],
  [0, -1, 0, 1],
  [0, 0, 1, 1],
  [0, 0, -1, 1],
  [1, 1, 0, Math.SQRT2],
  [1, -1, 0, Math.SQRT2],
  [-1, 1, 0, Math.SQRT2],
  [-1, -1, 0, Math.SQRT2],
];

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

/** Mirrors {@link stackOcclusion} — kept local to avoid a lighting↔flood cycle. */
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
    // Height-0 floors hard-seal vertical passage; half/full use opacity.
    if (movedZ && seals[i]! && opacity[i]! < TRANSMISSION_EPSILON) {
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
 * Hybrid bake: Euclidean-cost sky flood + circular block emitters.
 */
export function computeLightingFlood(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ambient: [number, number, number],
  overrides?: ReadonlyArray<EmitterOverride>,
  omitLightTileIds?: ReadonlySet<string>,
): LightGrid {
  const levels = new Map<number, LevelLightMap>();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  type Cell = { x: number; y: number; z: number; stack: PlacedTile[] };
  const cells: Cell[] = [];

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const [ck, stack] of Object.entries(level)) {
      if (!stack.length) continue;
      const { x, y } = parseCoordKey(ck);
      cells.push({ x, y, z, stack });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  if (!Number.isFinite(minX)) return { levels };

  const overrideByCell = new Map<string, EmitterOverride>();
  if (overrides) {
    for (const o of overrides) {
      overrideByCell.set(`${o.z}:${coordKey(o.x, o.y)}`, o);
    }
  }

  const emitters: EmitterSeed[] = [];
  let maxRadius = 0;
  for (const c of cells) {
    const ov = overrideByCell.get(`${c.z}:${coordKey(c.x, c.y)}`);
    for (let si = 0; si < c.stack.length; si++) {
      const placed = c.stack[si]!;
      if (omitLightTileIds?.has(placed.tileId)) continue;
      const def = tilesById[placed.tileId];
      if (!def?.light) continue;
      if (!(def.light.radius > 0) || !(def.light.intensity > 0)) continue;
      const [cr, cg, cb] = parseHexColor(def.light.color);
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
        radius: def.light.radius,
        intensity: def.light.intensity,
        r: cr,
        g: cg,
        b: cb,
      });
      if (def.light.radius > maxRadius) maxRadius = def.light.radius;
      const rx = Math.ceil(def.light.radius);
      if (ex - rx < minX) minX = Math.floor(ex - rx);
      if (ey - rx < minY) minY = Math.floor(ey - rx);
      if (ex + rx > maxX) maxX = Math.ceil(ex + rx);
      if (ey + rx > maxY) maxY = Math.ceil(ey + rx);
      if (ez - rx < minZ) minZ = Math.floor(ez - rx);
      if (ez + rx > maxZ) maxZ = Math.ceil(ez + rx);
    }
  }

  const pad = Math.max(1, Math.ceil(maxRadius));
  const dom: Domain = {
    x0: minX - pad,
    y0: minY - pad,
    z0: Math.max(MIN_LEVEL, minZ - 1),
    w: maxX - minX + 1 + pad * 2,
    h: maxY - minY + 1 + pad * 2,
    d: 0,
  };
  const zTop = Math.min(MAX_LEVEL, maxZ + 1);
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

  // Sky column seed. Full solids still receive the shaft that hits their top —
  // otherwise outdoor bricks bake black. Half-blocks attenuate the shaft by
  // half; height-0 floors seal it. Flood spreads through non-full cells.
  for (let ly = 0; ly < dom.h; ly++) {
    for (let lx = 0; lx < dom.w; lx++) {
      let shaft = MAX_LIGHT_LEVEL;
      for (let lz = dom.d - 1; lz >= 0; lz--) {
        const i = idx(dom, lx, ly, lz);
        const op = opacity[i]!;
        sky[i] = shaft;
        if (op >= 1) {
          shaft = 0;
        } else if (op > 0) {
          shaft *= 1 - op;
        } else if (seals[i]!) {
          shaft = 0;
        }
      }
    }
  }

  // Sky spread with Euclidean edge costs (rounder than Manhattan diamonds).
  // Full opaques are not enqueued — their shaft paint must not spill through
  // walls. Half-blocks participate and decay light by half on entry.
  const skyQ = new Int32Array(n);
  let skyLen = 0;
  for (let i = 0; i < n; i++) {
    if (opacity[i]! >= 1) continue;
    if (sky[i]! > 0.5) skyQ[skyLen++] = i;
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
    for (let ei = 0; ei < SKY_EDGES.length; ei++) {
      const [dx, dy, dz, cost] = SKY_EDGES[ei]!;
      const tx = lx + dx;
      const ty = ly + dy;
      const tz = lz + dz;
      if (tx < 0 || ty < 0 || tz < 0 || tx >= dom.w || ty >= dom.h || tz >= dom.d) {
        continue;
      }
      const j = idx(dom, tx, ty, tz);
      const topOp = opacity[j]!;
      if (topOp >= 1) continue;
      if (dz !== 0) {
        const upper = dz > 0 ? j : i;
        // Height-0 floors hard-seal vertical flood edges.
        if (seals[upper]! && opacity[upper]! < TRANSMISSION_EPSILON) continue;
      }
      let next = s - cost;
      if (topOp > 0) next *= 1 - topOp;
      if (next > sky[j]!) {
        sky[j] = next;
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
            // Height-0 floors refuse light climbing from below.
            if (
              tz > sz &&
              seals[i]! &&
              opacity[i]! < TRANSMISSION_EPSILON
            ) {
              continue;
            }
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
    const rgb = new Uint8Array(dom.w * dom.h * 3);
    for (let ly = 0; ly < dom.h; ly++) {
      for (let lx = 0; lx < dom.w; lx++) {
        const i = idx(dom, lx, ly, lz);
        const pi = (ly * dom.w + lx) * 3;
        const sk = Math.min(1, sky[i]! / MAX_LIGHT_LEVEL);
        if (opacity[i]! >= 1) {
          const br = blockR[i]!;
          const bg = blockG[i]!;
          const bb = blockB[i]!;
          if (br + bg + bb > 0.01) {
            rgb[pi] = Math.round(Math.min(1, br) * 255);
            rgb[pi + 1] = Math.round(Math.min(1, bg) * 255);
            rgb[pi + 2] = Math.round(Math.min(1, bb) * 255);
          } else {
            rgb[pi] = Math.round(Math.min(1, sk * ambient[0]) * 255);
            rgb[pi + 1] = Math.round(Math.min(1, sk * ambient[1]) * 255);
            rgb[pi + 2] = Math.round(Math.min(1, sk * ambient[2]) * 255);
          }
          continue;
        }
        rgb[pi] = Math.round(
          Math.min(1, sk * ambient[0] + blockR[i]!) * 255,
        );
        rgb[pi + 1] = Math.round(
          Math.min(1, sk * ambient[1] + blockG[i]!) * 255,
        );
        rgb[pi + 2] = Math.round(
          Math.min(1, sk * ambient[2] + blockB[i]!) * 255,
        );
      }
    }
    levels.set(z, { x0: dom.x0, y0: dom.y0, w: dom.w, h: dom.h, rgb });
  }

  return { levels };
}
