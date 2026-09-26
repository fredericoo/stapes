import { chunkKeyAt, chunkKeyFor, getChunk, getStack } from "./mapData";
import { type CellOcclusion, rayTransmission, stackOcclusion } from "./lighting";
import type { ChunkCells, LevelChunks, MapFile, TileDef } from "./types";
import { CHUNK_SIZE, HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, coordKey, levelKey } from "./types";

export const VIEW_RADIUS = 2.5;

const TRANSMISSION_EPSILON = 1e-3;

export type ViewAnchor = { x: number; y: number; z: number };

export type ViewAnchorActor = {
  x: number;
  y: number;
  z: number;
  walk: { to: { x: number; y: number; z: number } } | null;
  fall: { landingAbs: number } | null;
};

function cellKey(x: number, y: number, z: number): string {
  return `${z}:${coordKey(x, y)}`;
}

function levelForFeetAbs(feetAbs: number): number {
  let z = Math.floor(feetAbs / HEIGHT_PER_LEVEL);
  if (z < MIN_LEVEL) z = MIN_LEVEL;
  if (z > MAX_LEVEL) z = MAX_LEVEL;
  return z;
}

export function viewAnchorFor(actor: ViewAnchorActor): ViewAnchor {
  if (actor.walk) {
    return { x: actor.walk.to.x, y: actor.walk.to.y, z: actor.walk.to.z };
  }
  if (actor.fall) {
    return {
      x: actor.x,
      y: actor.y,
      z: levelForFeetAbs(actor.fall.landingAbs),
    };
  }
  return { x: actor.x, y: actor.y, z: actor.z };
}

function buildOcclusion(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  span: number,
): Map<string, CellOcclusion> {
  const occlusion = new Map<string, CellOcclusion>();
  if (!map.levels[levelKey(view.z)]) return occlusion;

  for (let y = view.y - span; y <= view.y + span; y++) {
    for (let x = view.x - span; x <= view.x + span; x++) {
      const stack = getStack(map, x, y, view.z);
      if (!stack.length) continue;
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, view.z), occ);
      }
    }
  }
  return occlusion;
}

function contentAbove(map: MapFile, x: number, y: number, viewZ: number, into: number[]): number[] {
  into.length = 0;
  for (let z = viewZ + 1; z <= MAX_LEVEL; z++) {
    if (getStack(map, x, y, z).length > 0) into.push(z);
  }
  return into;
}

function hideRayClear(
  x0: number,
  y0: number,
  z: number,
  x1: number,
  y1: number,
  occlusion: Map<string, CellOcclusion>,
): boolean {
  if (x0 === x1 && y0 === y1) return true;

  const transmission = rayTransmission(x0, y0, z, x1, y1, z, occlusion);
  if (transmission < TRANSMISSION_EPSILON) return false;

  const dest = occlusion.get(cellKey(x1, y1, z));
  if (dest && dest.opacity >= 1 - TRANSMISSION_EPSILON) return false;

  return true;
}

/**
 * Measured, not guessed: sampling every anchor across `data/map.json`, the
 * largest structure the shipped map cuts is 392 cells and every underground
 * anchor refuses. Past the cap the cut degrades to the whole storey rather
 * than a truncated fill, so raising or lowering this only changes how much
 * work is spent discovering that a cave ceiling is not a building.
 */
export const MAX_CUT_CELLS = 1024;

export type RoofCut = {
  readonly floor: number;
  readonly cells: ReadonlyMap<number, ReadonlySet<string>> | null;
};

export function cutHides(cut: RoofCut | undefined, x: number, y: number, z: number): boolean {
  if (!cut || z <= cut.floor) return false;
  if (cut.cells === null) return true;
  return cut.cells.get(z)?.has(coordKey(x, y)) === true;
}

export function cutHidesWholeLevel(cut: RoofCut | undefined, z: number): boolean {
  return cut !== undefined && cut.cells === null && z > cut.floor;
}

function cutSeeds(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  radius: number,
): Array<{ x: number; y: number; z: number }> {
  const r2 = radius * radius;
  const span = Math.ceil(radius);
  const occlusion = buildOcclusion(map, tilesById, view, span);
  const seeds: Array<{ x: number; y: number; z: number }> = [];
  const levels: number[] = [];

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx * dx + dy * dy > r2) continue;

      const x = view.x + dx;
      const y = view.y + dy;
      if (contentAbove(map, x, y, view.z, levels).length === 0) continue;
      if (!hideRayClear(view.x, view.y, view.z, x, y, occlusion)) continue;

      for (const z of levels) seeds.push({ x, y, z });
    }
  }
  return seeds;
}

/**
 * 26-way adjacency, deliberately the most generous there is: merging two
 * structures that only touch at a corner costs one extra roof lifting with
 * yours, while splitting a structure costs a hard diagonal edge through a
 * building. Including the level above and below keeps a two-storey house
 * whose upper floor sits one cell in from its roof from cutting as two
 * things.
 */
function fillStructure(
  map: MapFile,
  floor: number,
  seeds: ReadonlyArray<{ x: number; y: number; z: number }>,
): Map<number, Set<string>> | null {
  const byLevel = new Map<number, Set<string>>();
  const queue = [...seeds];
  let size = 0;

  const claim = (x: number, y: number, z: number): boolean => {
    let level = byLevel.get(z);
    if (!level) {
      level = new Set();
      byLevel.set(z, level);
    }
    const key = coordKey(x, y);
    if (level.has(key)) return false;
    level.add(key);
    size++;
    return true;
  };

  for (const seed of seeds) claim(seed.x, seed.y, seed.z);

  /**
   * This occupancy test is the whole cost of the fill, so it does not go
   * through `getStack`, which builds three keys per probe. Neighbours are
   * adjacent by construction, so nearly all of them share a chunk with the
   * one before, and holding the last level and chunk record makes the common
   * case a single object lookup instead.
   */
  let lastZ = Number.NaN;
  let lastLevel: LevelChunks | undefined;
  let lastChunkKey = "";
  let lastChunk: ChunkCells | undefined;
  const occupied = (x: number, y: number, z: number): boolean => {
    if (z !== lastZ) {
      lastZ = z;
      lastLevel = map.levels[levelKey(z)];
      lastChunkKey = "";
      lastChunk = undefined;
    }
    if (lastLevel === undefined) return false;
    const chunkKey = chunkKeyFor(x, y);
    if (chunkKey !== lastChunkKey) {
      lastChunkKey = chunkKey;
      lastChunk = lastLevel[chunkKey];
    }
    const stack = lastChunk?.[coordKey(x, y)];
    return stack !== undefined && stack.length > 0;
  };

  for (let head = 0; head < queue.length; head++) {
    if (size > MAX_CUT_CELLS) return null;
    const cell = queue[head]!;
    for (let dz = -1; dz <= 1; dz++) {
      const z = cell.z + dz;
      if (z <= floor || z > MAX_LEVEL) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const x = cell.x + dx;
          const y = cell.y + dy;
          if (!occupied(x, y, z)) continue;
          if (!claim(x, y, z)) continue;
          queue.push({ x, y, z });
        }
      }
    }
  }

  return byLevel;
}

export function roofCutFor(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  radius = VIEW_RADIUS,
): RoofCut | undefined {
  const seeds = cutSeeds(map, tilesById, view, radius);
  if (seeds.length === 0) return undefined;
  return { floor: view.z, cells: fillStructure(map, view.z, seeds) };
}

export function cutProbeChunks(map: MapFile, view: ViewAnchor, radius = VIEW_RADIUS): unknown[] {
  const span = Math.ceil(radius);
  const out: unknown[] = [];
  const cx0 = Math.floor((view.x - span) / CHUNK_SIZE);
  const cx1 = Math.floor((view.x + span) / CHUNK_SIZE);
  const cy0 = Math.floor((view.y - span) / CHUNK_SIZE);
  const cy1 = Math.floor((view.y + span) / CHUNK_SIZE);
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        out.push(getChunk(map, z, chunkKeyAt(cx, cy)));
      }
    }
  }
  return out;
}

export function sameProbeChunks(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
