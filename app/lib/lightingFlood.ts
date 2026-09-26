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
import { chunkIndexOf, chunkKeyAt, elevationAt, footElevation, terrainHeight } from "./mapData";
import type { AnimatedEmitter, EmitterOverride, RawLightGrid, RawLevelLight } from "./lighting";
import { resolveLight } from "./tileResolve";

export { MAX_LIGHT_LEVEL };

const TRANSMISSION_EPSILON = 1e-3;
const VERTICAL_FALLOFF = 1;

const NO_TILE_IN_COLUMN = MAX_LEVEL + 1;

const FULL_SHAFT_NOWHERE = -1;

const SKY_EDGE_STRIDE = 4;
const SKY_EDGES = new Float64Array([
  1,
  0,
  0,
  1,
  -1,
  0,
  0,
  1,
  0,
  1,
  0,
  1,
  0,
  -1,
  0,
  1,
  0,
  0,
  1,
  1,
  0,
  0,
  -1,
  1,
  1,
  1,
  0,
  Math.SQRT2,
  1,
  -1,
  0,
  Math.SQRT2,
  -1,
  1,
  0,
  Math.SQRT2,
  -1,
  -1,
  0,
  Math.SQRT2,
]);
const SKY_EDGE_COUNT = SKY_EDGES.length / SKY_EDGE_STRIDE;

const SKY_QUEUE_HEADROOM = 2;

const canEmitByDef = new WeakMap<TileDef, boolean>();

function canEmit(def: TileDef): boolean {
  let known = canEmitByDef.get(def);
  if (known === undefined) {
    known = tileCanEmitLight(def);
    canEmitByDef.set(def, known);
  }
  return known;
}

export function parseHexColor(hex: string): [number, number, number] {
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

function stackOcc(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): { opacity: number; seals: boolean } {
  let elev = 0;
  let blockH = 0;
  let seals = false;
  for (const placed of stack) {
    const foot = footElevation(elev, placed);
    if (foot > elev) {
      blockH += foot - elev;
      seals = true;
    }
    elev = foot + terrainHeight(placed, tilesById);

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
  const baseAbs = z * HEIGHT_PER_LEVEL + elevationAt(stack, stackIndex, tilesById);
  return {
    fx: x + 0.5,
    fy: y + 0.5,
    fz: (baseAbs + height / 2) / HEIGHT_PER_LEVEL,
  };
}

type EmitterSeed = {
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
    if (movedZ) {
      const lidLz = (stepZ > 0 ? z : z + 1) - dom.z0;
      const lidLx = x - dom.x0;
      const lidLy = y - dom.y0;
      if (
        lidLx >= 0 &&
        lidLy >= 0 &&
        lidLz >= 0 &&
        lidLx < dom.w &&
        lidLy < dom.h &&
        lidLz < dom.d &&
        seals[idx(dom, lidLx, lidLy, lidLz)]!
      ) {
        return 0;
      }
    }
    if (x === x1 && y === y1 && z === z1) break;
    const lx = x - dom.x0;
    const ly = y - dom.y0;
    const lz = z - dom.z0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= dom.w || ly >= dom.h || lz >= dom.d) {
      continue;
    }
    const i = idx(dom, lx, ly, lz);
    const op = opacity[i]!;
    if (op > 0) {
      transmission *= 1 - op;
      if (transmission < TRANSMISSION_EPSILON) return 0;
    }
  }
  return transmission;
}

export type FloodDomain = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
};

type FloodCell = { x: number; y: number; z: number; stack: PlacedTile[] };

function collectAnimatedEmitters(
  cells: readonly FloodCell[],
  tilesById: Record<string, TileDef>,
  omitLightTileIds: ReadonlySet<string> | undefined,
): AnimatedEmitter[] {
  const varying = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (tileLightVaries(def)) varying.add(def.id);
  }
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
  for (const ck in chunk) {
    const stack = chunk[ck]!;
    if (!stack.length) continue;
    const { x, y } = parseCoordKey(ck);
    into.push({ x, y, z, stack });
  }
}

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
    const ov = overrideByCell.size ? overrideByCell.get(`${c.z}:${coordKey(c.x, c.y)}`) : undefined;
    for (let si = 0; si < c.stack.length; si++) {
      const placed = c.stack[si]!;
      if (omitLightTileIds?.has(placed.tileId)) continue;
      const def = tilesById[placed.tileId];
      if (!def) continue;
      if (!canEmit(def)) continue;
      const light = resolveLight(
        def,
        {
          map,
          x: c.x,
          y: c.y,
          z: c.z,
          direction: placed.direction,
          variant: placed.variant,
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
      const rx = Math.ceil(light.radius);
      if (ex - rx < minX) minX = Math.floor(ex - rx);
      if (ey - rx < minY) minY = Math.floor(ey - rx);
      if (ex + rx > maxX) maxX = Math.ceil(ex + rx);
      if (ey + rx > maxY) maxY = Math.ceil(ey + rx);
      if (ez - rx < minZ) minZ = Math.floor(ez - rx);
      if (ez + rx > maxZ) maxZ = Math.ceil(ez + rx);
    }
  }

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

  let skyQ = new Int32Array(n * SKY_QUEUE_HEADROOM);
  let skyLen = 0;

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

  for (const e of emitters) {
    const rCells = Math.ceil(e.radius);
    const sx = Math.floor(e.x);
    const sy = Math.floor(e.y);
    const sz = Math.floor(e.z);
    const selfLx = e.lx - dom.x0;
    const selfLy = e.ly - dom.y0;
    const selfLz = e.lz - dom.z0;
    let savedSelfOp = 0;
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
      opacity[si] = 0;
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
            dx * dx + dy * dy + dz * VERTICAL_FALLOFF * (dz * VERTICAL_FALLOFF),
          );
          if (dist > e.radius) continue;

          const i = idx(dom, lx, ly, lz);
          const isSelf = tx === e.lx && ty === e.ly && tz === e.lz;
          if (!isSelf) {
            if (opacity[i]! >= 1) continue;
            if (isVoid[i]!) continue;
            if (tz > sz && seals[i]!) continue;
          }

          let transmission = 1;
          if (!isSelf && dist > 0) {
            transmission = denseRayTransmission(dom, opacity, seals, sx, sy, sz, tx, ty, tz);
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
      opacity[idx(dom, selfLx, selfLy, selfLz)] = savedSelfOp;
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
