import type { LightDef, MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  resolveLightPassing,
} from "./types";
import { elevationAt, footElevation, getStack, terrainHeight } from "./mapData";
import { computeLightingFlood, MAX_LIGHT_LEVEL, parseHexColor } from "./lightingFlood";
import { resolveLight } from "./tileResolve";

export { MAX_LIGHT_LEVEL };

export const VERTICAL_FALLOFF = 1;

const TRANSMISSION_EPSILON = 1e-3;

export type LevelLightMap = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  rgb: Uint8Array;
};

export type LightGrid = {
  levels: Map<number, LevelLightMap>;
};

export type RawLevelLight = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  sky: Uint8Array;
  block: Uint8Array;
};

export type AnimatedEmitter = {
  tileId: string;
  x: number;
  y: number;
  radius: number;
};

export type RawLightGrid = {
  levels: Map<number, RawLevelLight>;
  animated: AnimatedEmitter[];
};

export type PackedLevelLight = {
  x0: number;
  y0: number;
  w: number;
  h: number;
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

export const VOID_BACKGROUND = 0x000000;

export const AMBIENT_PRESETS = {
  day: [1, 1, 1] as [number, number, number],
  dusk: [0.55, 0.4, 0.3] as [number, number, number],
  night: [0.04, 0.05, 0.1] as [number, number, number],
};

export function composeAmbientRgb(
  sky: Uint8Array,
  block: Uint8Array,
  ambient: [number, number, number],
  rgb: Uint8Array,
): void {
  for (let i = 0, p = 0; i < sky.length; i++, p += 3) {
    const sk = sky[i]! / 255;
    rgb[p] = Math.round(Math.min(1, sk * ambient[0] + block[p]! / 255) * 255);
    rgb[p + 1] = Math.round(Math.min(1, sk * ambient[1] + block[p + 1]! / 255) * 255);
    rgb[p + 2] = Math.round(Math.min(1, sk * ambient[2] + block[p + 2]! / 255) * 255);
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

export function composeLightGrid(raw: RawLightGrid, ambient: [number, number, number]): LightGrid {
  const levels = new Map<number, LevelLightMap>();
  for (const [z, level] of raw.levels) {
    levels.set(z, composeLevelLight(level, ambient));
  }
  return { levels };
}

export type CellOcclusion = {
  opacity: number;
  sealsLevel: boolean;
};

export type EmitterOverride = {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  lights?: readonly LightDef[];
};

type Emitter = {
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

function cellKey(x: number, y: number, z: number): string {
  return `${z}:${coordKey(x, y)}`;
}

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

export function stackOcclusion(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): CellOcclusion {
  let elev = 0;
  let blockH = 0;
  let sealsLevel = false;
  for (const placed of stack) {
    const foot = footElevation(elev, placed);
    if (foot > elev) {
      blockH += foot - elev;
      sealsLevel = true;
    }
    elev = foot + terrainHeight(placed, tilesById);

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

export function stackBlockHeight(stack: PlacedTile[], tilesById: Record<string, TileDef>): number {
  let elev = 0;
  let blockH = 0;
  for (const placed of stack) {
    const foot = footElevation(elev, placed);
    blockH += foot - elev;
    elev = foot + terrainHeight(placed, tilesById);

    const def = tilesById[placed.tileId];
    if (!def || resolveLightPassing(def)) continue;
    blockH += def.height;
  }
  return blockH;
}

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

    /**
     * A tile sits on its own level's floor plane, so the lid between two
     * cells belongs to the upper of them. Reading the cell the step arrived
     * in instead checks the wrong lid on the way down, and a torch lights
     * the cave below the one it stands in.
     */
    if (movedZ) {
      const lid = occlusion.get(cellKey(x, y, stepZ > 0 ? z : z + 1));
      if (lid?.sealsLevel) return 0;
    }

    if (x === x1 && y === y1 && z === z1) break;

    const cell = occlusion.get(cellKey(x, y, z));
    if (!cell) continue;

    if (cell.opacity > 0) {
      transmission *= 1 - cell.opacity;
      if (transmission < TRANSMISSION_EPSILON) return 0;
    }
  }

  return transmission;
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

  /**
   * The emitter's own cell must not shadow it sideways, so its opacity is
   * cleared for the cast and restored below. Its seal is left alone: that
   * seal is the floor the emitter stands on, and clearing it too would let
   * the light through to the storey underneath.
   */
  const selfIndex = denseIndex(occlusion, e.lx, e.ly, e.lz);
  const savedSelfOpacity = selfIndex < 0 ? 0 : occlusion.opacity[selfIndex]!;
  if (selfIndex >= 0) occlusion.opacity[selfIndex] = 0;

  for (let tz = zLo; tz <= zHi; tz++) {
    const floats = floatsByZ.get(tz);
    if (!floats) continue;
    for (let ty = yLo; ty <= yHi; ty++) {
      for (let tx = xLo; tx <= xHi; tx++) {
        const dx = tx - e.x;
        const dy = ty - e.y;
        const dz = tz - e.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * VERTICAL_FALLOFF * (dz * VERTICAL_FALLOFF));
        if (dist > e.radius) continue;

        const isSelf = tx === e.lx && ty === e.ly && tz === e.lz;
        const ti = denseIndex(occlusion, tx, ty, tz);
        const targetOpacity = ti < 0 ? 0 : occlusion.opacity[ti]!;
        const targetSeals = ti < 0 ? 0 : occlusion.seals[ti]!;
        const targetVoid = ti < 0 ? 0 : occlusion.voids[ti]!;

        if (!isSelf) {
          if (targetOpacity >= 1) continue;
          if (targetVoid) continue;
          if (tz > sz && targetSeals) continue;
        }

        let transmission = 1;
        if (!isSelf && dist > 0) {
          transmission = denseRayTransmission(occlusion, sx, sy, sz, tx, ty, tz);
          if (transmission < TRANSMISSION_EPSILON) continue;
        }

        const t = 1 - dist / e.radius;
        const atten = t * t * e.intensity * transmission;
        if (atten < TRANSMISSION_EPSILON) continue;

        accumulateAt(floats, x0, y0, w, h, tx, ty, e.r * atten, e.g * atten, e.b * atten);
      }
    }
  }

  if (selfIndex >= 0) occlusion.opacity[selfIndex] = savedSelfOpacity;
}

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

function collectOverrideEmitters(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
  timeMs: number,
): Emitter[] {
  const emitters: Emitter[] = [];
  for (const ov of overrides) {
    if (ov.lights) {
      for (const light of ov.lights) pushEmitter(emitters, ov, light);
      continue;
    }
    const stack = getStack(map, ov.x, ov.y, ov.z);
    if (!stack.length) continue;
    for (const placed of stack) {
      const def = tilesById[placed.tileId];
      if (!def) continue;
      const light = resolveLight(
        def,
        {
          map,
          x: ov.x,
          y: ov.y,
          z: ov.z,
          direction: placed.direction,
          variant: placed.variant,
        },
        timeMs,
      );
      if (!light) continue;
      pushEmitter(emitters, ov, light);
    }
  }
  return emitters;
}

function pushEmitter(emitters: Emitter[], ov: EmitterOverride, light: LightDef) {
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

export type DenseOcclusion = {
  reach: Reach;
  w: number;
  h: number;
  d: number;
  opacity: Float32Array;
  seals: Uint8Array;
  voids: Uint8Array;
};

const NO_TILE_IN_REACH = MAX_LEVEL + 1;

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
    voids: new Uint8Array(w * h * d),
  };

  const lowestTileZ = new Int32Array(w * h).fill(NO_TILE_IN_REACH);
  for (let z = Math.max(MIN_LEVEL, reach.z0); z <= Math.min(MAX_LEVEL, reach.z1); z++) {
    if (!map.levels[levelKey(z)]) continue;
    fillDenseLevel(dense, map, tilesById, z, lowestTileZ);
  }
  fillDenseVoids(dense, map, lowestTileZ);
  return dense;
}

function fillDenseVoids(dense: DenseOcclusion, map: MapFile, lowestTileZ: Int32Array) {
  const { reach, w, h } = dense;
  const levelsBelow: number[] = [];
  for (let z = reach.z0 - 1; z >= MIN_LEVEL; z--) {
    if (map.levels[levelKey(z)]) levelsBelow.push(z);
  }
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const lowest = lowestTileZ[ly * w + lx]!;
      if (lowest <= reach.z0) continue;
      const x = reach.x0 + lx;
      const y = reach.y0 + ly;
      if (columnHasTileAt(map, x, y, levelsBelow)) continue;
      markVoidColumn(dense, x, y, Math.min(reach.z1, lowest - 1));
    }
  }
}

function columnHasTileAt(map: MapFile, x: number, y: number, levels: readonly number[]): boolean {
  for (const z of levels) {
    if (getStack(map, x, y, z).length) return true;
  }
  return false;
}

function markVoidColumn(dense: DenseOcclusion, x: number, y: number, zTop: number) {
  for (let z = dense.reach.z0; z <= zTop; z++) {
    dense.voids[denseIndex(dense, x, y, z)] = 1;
  }
}

function fillDenseLevel(
  dense: DenseOcclusion,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  z: number,
  lowestTileZ: Int32Array,
) {
  const { reach } = dense;
  for (let y = reach.y0; y <= reach.y1; y++) {
    for (let x = reach.x0; x <= reach.x1; x++) {
      const stack = getStack(map, x, y, z);
      if (!stack.length) continue;
      const col = (y - reach.y0) * dense.w + (x - reach.x0);
      if (z < lowestTileZ[col]!) lowestTileZ[col] = z;
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity <= 0 && !occ.sealsLevel) continue;
      const i = denseIndex(dense, x, y, z);
      if (i < 0) continue;
      dense.opacity[i] = occ.opacity;
      dense.seals[i] = occ.sealsLevel ? 1 : 0;
    }
  }
}

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

    /** The lid of the upper cell of the pair — see {@link rayTransmission}. */
    if (movedZ) {
      const lidIndex = denseIndex(o, x, y, stepZ > 0 ? z : z + 1);
      if (lidIndex >= 0 && o.seals[lidIndex]!) return 0;
    }

    if (x === x1 && y === y1 && z === z1) break;

    const i2 = denseIndex(o, x, y, z);
    if (i2 < 0) continue;
    const opacity = o.opacity[i2]!;
    if (opacity > 0) {
      transmission *= 1 - opacity;
      if (transmission < TRANSMISSION_EPSILON) return 0;
    }
  }
  return transmission;
}

type ChannelView = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Uint8Array;
  stride: number;
};

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

export function overlayEmitterOverridesPacked(
  base: PackedLightGrid,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
  timeMs = 0,
): PackedLightGrid {
  if (!overrides.length) return clonePackedLightGrid(base);

  const emitters = collectOverrideEmitters(map, tilesById, overrides, timeMs);
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

export function overlayEmitterOverrides(
  base: LightGrid,
  map: MapFile,
  tilesById: Record<string, TileDef>,
  overrides: ReadonlyArray<EmitterOverride>,
  timeMs = 0,
): LightGrid {
  if (!overrides.length) return cloneLightGrid(base);

  const emitters = collectOverrideEmitters(map, tilesById, overrides, timeMs);
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

export const PITCH_BLACK_LIGHT = 0.02;

export function isPitchBlack(
  grid: PackedLightGrid,
  ambient: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
): boolean {
  const level = grid.levels.get(z);
  if (!level) return true;
  for (let dy = -1; dy <= 1; dy++) {
    const ly = y + dy - level.y0;
    if (ly < 0 || ly >= level.h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const lx = x + dx - level.x0;
      if (lx < 0 || lx >= level.w) continue;
      const i = (ly * level.w + lx) * 4;
      const sky = level.rgba[i + 3]! / 255;
      for (let c = 0; c < 3; c++) {
        if (sky * ambient[c]! + level.rgba[i + c]! / 255 >= PITCH_BLACK_LIGHT) return false;
      }
    }
  }
  return true;
}
