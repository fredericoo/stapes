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

/**
 * How far sky-exposed cells spill into covered cells (same falloff model as
 * point lights). Exposed cells themselves get a direct sky-color write so
 * overlapping outdoor emitters do not wash out.
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
 * Cast one emitter into `floatsByZ`. When `skyExposed` is set, skip targets that
 * are already sky-lit (spill-only mode for outdoor cells).
 *
 * `removeSelfOcclusion` should stay true for tile emitters (a lamp must not block
 * its own light) and false for sky spill so a sky-lit roof plate cannot shine
 * through itself into the room below.
 */
function castEmitter(
  e: Emitter,
  occlusion: Map<string, CellOcclusion>,
  floatsByZ: Map<number, Float32Array>,
  x0: number,
  y0: number,
  w: number,
  h: number,
  skyExposed?: Set<string>,
  removeSelfOcclusion = true,
) {
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

  const selfKey = cellKey(e.lx, e.ly, e.lz);
  const selfOcc = occlusion.get(selfKey);
  const savedSelfOcc = removeSelfOcclusion ? selfOcc : undefined;
  if (removeSelfOcclusion) occlusion.delete(selfKey);

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
        const targetKey = cellKey(tx, ty, tz);

        // Sky spill only fills cover — exposed cells already have a direct write.
        if (skyExposed?.has(targetKey)) continue;

        // Sky-lit floor/roof plates must not shine through themselves into the
        // level below (endpoint exclusion would otherwise let a 1-step vertical
        // ray past the seal). Open air emitters may still spill downward.
        if (skyExposed && tz < sz && selfOcc?.sealsLevel) {
          continue;
        }

        const target = occlusion.get(targetKey);

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
 * Build a per-level RGB light grid from map tile defs + sky lighting.
 * Pure / deterministic — no Three.js.
 *
 * `ambient` is the sky color for the current time of day (not a flat fill).
 * Sky-exposed cells get that color directly; they also spill into covered
 * cells with falloff. Point-light emitters add on top unchanged.
 *
 * Optional `overrides` relocate emitters from their map cell to a fractional
 * cell-space position (e.g. mid-walk) so cast light tracks sprite motion.
 *
 * Optional `omitLightTileIds` skips those tiles as point emitters (sky occlusion
 * still uses them). Used so a moving player light can be overlaid cheaply
 * without re-baking static sky/torches each step.
 */
export function computeLighting(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ambient: [number, number, number],
  overrides?: ReadonlyArray<EmitterOverride>,
  omitLightTileIds?: ReadonlySet<string>,
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
  const occupiedCells = new Set<string>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxRadius = SKY_SPILL_RADIUS;
  const occupiedZ = new Set<number>();

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const [ck, stack] of Object.entries(level)) {
      if (!stack.length) continue;
      const { x, y } = parseCoordKey(ck);
      occupiedZ.add(z);
      occupiedCells.add(cellKey(x, y, z));
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, z), occ);
      }

      for (const placed of stack) {
        if (omitLightTileIds?.has(placed.tileId)) continue;
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

  // Top-down sky mask: a cell is exposed iff nothing above sealed the shaft.
  // Scan the full Z range so high roofs still shade lower levels in the bbox.
  const skyExposed = new Set<string>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let blockedFromAbove = false;
      for (let z = MAX_LEVEL; z >= zMin; z--) {
        if (!blockedFromAbove && z <= zMax) {
          skyExposed.add(cellKey(x, y, z));
        }
        const cell = occlusion.get(cellKey(x, y, z));
        if (cell && (cell.sealsLevel || cell.opacity >= 1)) {
          blockedFromAbove = true;
        }
      }
    }
  }

  // Base = 0; sky-exposed cells get a direct sky-color write (no outdoor overlap).
  const floatsByZ = new Map<number, Float32Array>();
  for (let z = zMin; z <= zMax; z++) {
    const floats = new Float32Array(w * h * 3);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!skyExposed.has(cellKey(x, y, z))) continue;
        const lx = x - x0;
        const ly = y - y0;
        const i = (ly * w + lx) * 3;
        floats[i] = ambient[0];
        floats[i + 1] = ambient[1];
        floats[i + 2] = ambient[2];
      }
    }
    floatsByZ.set(z, floats);
  }

  // Only sky cells near real cover need to spill — open plains are direct-write
  // only. Skip empty emitter-pad cells under outdoor floors (not occupied, no
  // occlusion of their own) so they don't invent underground caves.
  // Spill emitters are map-occupied, non-solid sky cells (floors under open sky /
  // skylight holes) — empty pad air and walls must not flood cover from above.
  const spillSources = new Set<string>();
  const rSpill = Math.ceil(SKY_SPILL_RADIUS);
  for (let z = zMin; z <= zMax; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = cellKey(x, y, z);
        if (skyExposed.has(key)) continue;
        if (!occupiedZ.has(z) && !occlusion.has(key)) continue;
        for (let dz = -rSpill; dz <= rSpill; dz++) {
          const zz = z + dz;
          if (zz < zMin || zz > zMax) continue;
          for (let dy = -rSpill; dy <= rSpill; dy++) {
            for (let dx = -rSpill; dx <= rSpill; dx++) {
              if (dx * dx + dy * dy + dz * dz > SKY_SPILL_RADIUS * SKY_SPILL_RADIUS) {
                continue;
              }
              const sk = cellKey(x + dx, y + dy, zz);
              if (!skyExposed.has(sk)) continue;
              if (!occupiedCells.has(sk)) continue;
              const skOcc = occlusion.get(sk);
              if (skOcc && skOcc.opacity >= 1) continue;
              spillSources.add(sk);
            }
          }
        }
      }
    }
  }

  for (const key of spillSources) {
    const colon = key.indexOf(":");
    const z = Number(key.slice(0, colon));
    const { x, y } = parseCoordKey(key.slice(colon + 1));
    castEmitter(
      {
        x,
        y,
        z,
        lx: x,
        ly: y,
        lz: z,
        radius: SKY_SPILL_RADIUS,
        intensity: 1,
        r: ambient[0],
        g: ambient[1],
        b: ambient[2],
      },
      occlusion,
      floatsByZ,
      x0,
      y0,
      w,
      h,
      skyExposed,
      false,
    );
  }

  for (const e of emitters) {
    castEmitter(e, occlusion, floatsByZ, x0, y0, w, h);
  }

  // Solid cells: no borrowed neighbour glow. Sky-exposed solids keep sky color;
  // buried solids stay black. Point-emitter cells keep self-lit contribution.
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
      if (skyExposed.has(key)) {
        floats[i] = ambient[0];
        floats[i + 1] = ambient[1];
        floats[i + 2] = ambient[2];
      } else {
        floats[i] = 0;
        floats[i + 1] = 0;
        floats[i + 2] = 0;
      }
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
 * Relocate map emitters onto a **pre-baked** static grid (sky + resting lights).
 * Subtracts each overridden emitter's contribution at its map cell, then adds
 * it at the fractional override — without re-running sky spill.
 *
 * Returns a new grid; `base` is not mutated.
 */
export function paintEmitterOverrides(
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
  const relocated: Array<{ rest: Emitter; moved: Emitter }> = [];

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
        const rest: Emitter = {
          x,
          y,
          z,
          lx: x,
          ly: y,
          lz: z,
          radius: def.light.radius,
          intensity: def.light.intensity,
          r: cr,
          g: cg,
          b: cb,
        };
        relocated.push({
          rest,
          moved: {
            ...rest,
            x: ov.fx,
            y: ov.fy,
            z: ov.fz,
          },
        });
      }
    }
  }

  if (!relocated.length) return cloneLightGrid(base);

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

  for (const { rest, moved } of relocated) {
    castEmitter(
      { ...rest, r: -rest.r, g: -rest.g, b: -rest.b },
      occlusion,
      floatsByZ,
      x0,
      y0,
      w,
      h,
    );
    castEmitter(moved, occlusion, floatsByZ, x0, y0, w, h);
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
