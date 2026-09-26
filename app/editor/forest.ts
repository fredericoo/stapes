import { getStack, isPlayerBody, setStacks, type StackEdit } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, physicalHeight, resolveActor } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import {
  MAX_FOOTPRINT,
  type Bounds,
  type CellGrid,
  type Connection,
  type GeneratedPlan,
  type Rect,
  type ScatterRule,
  boundsOf,
  clamp01,
  connectionsAlongBorder,
  countOpen,
  cutFords,
  fbm,
  gridIndex,
  gridX,
  gridY,
  isJoinableGround,
  isOpen,
  joinRegions,
  mulberry32,
  stepTowards,
  newGrid,
  openCells,
  openConnection,
  placed,
  planScatter,
  planWater,
  randomAt,
  setOpen,
  widenToTwo,
} from "./generator";

export type ForestConfig = {
  generator: "forest";
  seed: number;
  density: number;
  groundTileId: string;
  treeTileId: string;
  paths: number;
  pathWidth: number;
  pathTileId: string | null;
  waterTileId: string | null;
  waterCoverage: number;
  scatter: ScatterRule[];
};

export const MIN_FOREST_FOOTPRINT = 8;

export const FOREST_DENSITY_RANGE = { min: 0, max: 100 } as const;

/**
 * Two is the floor for the same reason no cave passage is one cell wide: the
 * oblique projection draws the tree in front of a one-cell path over the path.
 */
export const PATH_WIDTH_RANGE = { min: 2, max: 6 } as const;

export const PATH_COUNT_RANGE = { min: 1, max: 3 } as const;

const PATH_FALLOFF_SHARE = 0.4;
const MIN_PATH_FALLOFF = 6;

const THICKET_SCALE = 17;
const THICKET_OCTAVES = 2;
const THICKET_SWING = 0.55;

const CLUMP_SCALE = 7;
const CLUMP_OCTAVES = 2;
const CLUMP_SWING = 0.4;

const EDGE_DITHER = 5;
const EDGE_DITHER_FLOOR = 0.3;

const PATH_STRAY_CHANCE = 0.38;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function carvePath(
  g: CellGrid,
  bounds: Bounds,
  seed: number,
  index: number,
  width: number,
): Set<number> {
  const cells = new Set<number>();
  const random = mulberry32((seed ^ 0x9a7e) + index * 0x9e37);
  const horizontal = random() < 0.5;
  const forward = random() < 0.5;

  const lastX = bounds.maxX - width + 1;
  const lastY = bounds.maxY - width + 1;
  if (lastX < bounds.minX || lastY < bounds.minY) return cells;
  const anyX = () => bounds.minX + Math.floor(random() * (lastX - bounds.minX + 1));
  const anyY = () => bounds.minY + Math.floor(random() * (lastY - bounds.minY + 1));

  const entry = horizontal ? (forward ? bounds.minX : lastX) : forward ? bounds.minY : lastY;
  const exit = horizontal ? (forward ? lastX : bounds.minX) : forward ? lastY : bounds.minY;
  const at = horizontal ? { x: entry, y: anyY() } : { x: anyX(), y: entry };
  const mark = horizontal ? { x: exit, y: anyY() } : { x: anyX(), y: exit };

  const stamp = (x: number, y: number) => {
    for (let dy = 0; dy < width; dy++) {
      for (let dx = 0; dx < width; dx++) {
        cells.add(gridIndex(g, x + dx, y + dy));
      }
    }
  };

  const maxSteps = g.cells.length * 4;
  for (let step = 0; step < maxSteps; step++) {
    stamp(at.x, at.y);
    if (at.x === mark.x && at.y === mark.y) break;
    const towards =
      random() < PATH_STRAY_CHANCE
        ? STEPS[Math.floor(random() * STEPS.length)]!
        : stepTowards(at, mark, random);
    at.x = clamp(at.x + towards.dx, bounds.minX, lastX);
    at.y = clamp(at.y + towards.dy, bounds.minY, lastY);
  }
  return cells;
}

function distanceFromPath(g: CellGrid, path: ReadonlySet<number>): Int32Array {
  const distance = new Int32Array(g.cells.length).fill(-1);
  const queue: number[] = [];
  for (const i of path) {
    distance[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = gridX(g, i);
    const y = gridY(g, i);
    for (const { dx, dy } of STEPS) {
      if (!inBounds(g, x + dx, y + dy)) continue;
      const j = gridIndex(g, x + dx, y + dy);
      if (distance[j] !== -1) continue;
      distance[j] = distance[i]! + 1;
      queue.push(j);
    }
  }
  return distance;
}

function inBounds(g: CellGrid, x: number, y: number): boolean {
  return x >= g.minX && y >= g.minY && x < g.minX + g.width && y < g.minY + g.height;
}

const CONNECTION_DEPTH = 4;

export const MIN_GLADE_CELLS = 14;

function distanceFromEdge(bounds: Bounds, x: number, y: number): number {
  return Math.min(x - bounds.minX, bounds.maxX - x, y - bounds.minY, bounds.maxY - y);
}

function swing(
  x: number,
  y: number,
  seed: number,
  scale: number,
  octaves: number,
  amount: number,
): number {
  return 1 + (fbm(x, y, seed, scale, octaves) - 0.5) * 2 * amount;
}

export type ForestShape = {
  grid: CellGrid;
  path: Set<number>;
};

export function growForest(
  bounds: Bounds,
  config: ForestConfig,
  connections: readonly Connection[] = [],
): ForestShape {
  const grid = newGrid(bounds);
  grid.cells.fill(1);

  const path = new Set<number>();
  const paths = clamp(Math.round(config.paths), PATH_COUNT_RANGE.min, PATH_COUNT_RANGE.max);
  const width = clamp(Math.round(config.pathWidth), PATH_WIDTH_RANGE.min, PATH_WIDTH_RANGE.max);
  for (let index = 0; index < paths; index++) {
    for (const i of carvePath(grid, bounds, config.seed, index, width)) {
      path.add(i);
    }
  }

  const distance = distanceFromPath(grid, path);
  const density = clamp01(config.density / 100);
  const falloff = Math.max(
    MIN_PATH_FALLOFF,
    Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * PATH_FALLOFF_SHARE,
  );

  for (let i = 0; i < grid.cells.length; i++) {
    if (path.has(i)) continue;
    const x = gridX(grid, i);
    const y = gridY(grid, i);
    const fromPath = clamp01((distance[i] ?? falloff) / falloff);
    const thicket = swing(
      x,
      y,
      config.seed ^ 0x7471,
      THICKET_SCALE,
      THICKET_OCTAVES,
      THICKET_SWING,
    );
    const clump = swing(x, y, config.seed ^ 0xc10b, CLUMP_SCALE, CLUMP_OCTAVES, CLUMP_SWING);
    const edge =
      EDGE_DITHER_FLOOR +
      (1 - EDGE_DITHER_FLOOR) * clamp01(distanceFromEdge(bounds, x, y) / EDGE_DITHER);
    const chance = density * fromPath * thicket * clump * edge;
    if (randomAt(x, y, config.seed) < chance) grid.cells[i] = 0;
  }

  const ways = new Set<number>();
  for (const connection of connections) {
    for (const i of openConnection(grid, bounds, connection, CONNECTION_DEPTH)) {
      ways.add(i);
    }
  }

  widenToTwo(grid);
  for (const i of path) grid.cells[i] = 1;

  joinRegions(grid, bounds, config.seed, {
    minRegionCells: MIN_GLADE_CELLS,
    tooSmall: "leave",
    home: (region) => region.some((i) => path.has(i) || ways.has(i)),
  });
  return { grid, path };
}

export function planForest(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  rect: Rect,
  z: number,
  config: ForestConfig,
): GeneratedPlan {
  const bounds = boundsOf(rect);
  const width = bounds.maxX - bounds.minX + 1;
  const depth = bounds.maxY - bounds.minY + 1;

  if (width < MIN_FOREST_FOOTPRINT || depth < MIN_FOREST_FOOTPRINT) {
    return {
      ok: false,
      reason: `A forest is at least ${MIN_FOREST_FOOTPRINT}×${MIN_FOREST_FOOTPRINT} cells`,
    };
  }
  if (width > MAX_FOOTPRINT || depth > MAX_FOOTPRINT) {
    return {
      ok: false,
      reason: `A forest is at most ${MAX_FOOTPRINT}×${MAX_FOOTPRINT} cells`,
    };
  }

  const groundDef = tilesById[config.groundTileId];
  if (!groundDef) {
    return { ok: false, reason: `There is no tile called ${config.groundTileId}` };
  }
  const treeDef = tilesById[config.treeTileId];
  if (!treeDef) {
    return { ok: false, reason: `There is no tile called ${config.treeTileId}` };
  }
  const pathDef = config.pathTileId ? tilesById[config.pathTileId] : undefined;

  const groundHeight = physicalHeight(groundDef);
  const pathHeight = pathDef ? physicalHeight(pathDef) : 0;
  const standing = groundHeight + pathHeight + physicalHeight(treeDef);
  if (standing > HEIGHT_PER_LEVEL) {
    return {
      ok: false,
      reason: `The ground, the path and a ${treeDef.name} stand ${standing} units, past the ${HEIGHT_PER_LEVEL} a level holds`,
    };
  }

  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (const p of getStack(map, x, y, z)) {
        const def = tilesById[p.tileId];
        if (isPlayerBody(p) || (def && resolveActor(def))) {
          return { ok: false, reason: `Somebody is standing at ${x},${y}` };
        }
      }
    }
  }

  const ourGround = [config.groundTileId, config.pathTileId].filter(
    (id): id is string => id !== null,
  );
  const connections = connectionsAlongBorder(
    bounds,
    isJoinableGround(map, tilesById, z, ourGround),
  );

  const { grid, path } = growForest(bounds, config, connections);
  if (countOpen(grid) === 0) {
    return {
      ok: false,
      reason: "The forest closed over completely — lower the density",
    };
  }

  const water = config.waterTileId ? erodeWithWater(grid, bounds, config) : new Set<number>();
  cutFords(grid, water);

  const plantable = openCells(grid).filter((c) => {
    const i = gridIndex(grid, c.x, c.y);
    return !water.has(i) && !path.has(i);
  });
  const scatter = planScatter(
    plantable,
    config.scatter,
    config.seed ^ 0x5ca77e2,
    groundHeight,
    tilesById,
  );

  const edits: StackEdit[] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const i = gridIndex(grid, x, y);
      const stack: PlacedTile[] = [placed(config.groundTileId, tilesById)];
      if (config.pathTileId && path.has(i)) {
        stack.push(placed(config.pathTileId, tilesById));
      }
      if (config.waterTileId && water.has(i)) {
        stack.push(placed(config.waterTileId, tilesById));
      } else if (!isOpen(grid, x, y)) {
        stack.push(placed(config.treeTileId, tilesById));
      } else {
        const prop = scatter.get(`${x},${y}`);
        if (prop) stack.push(placed(prop, tilesById));
      }
      edits.push({ x, y, z, stack });
    }
  }

  const built = setStacks(map, edits);
  for (const edit of edits) {
    const check = canReplaceStack(built, edit.x, edit.y, edit.z, edit.stack, tilesById);
    if (!check.ok) {
      return { ok: false, reason: `${check.reason} at ${edit.x},${edit.y}` };
    }
  }

  return { ok: true, edits };
}

function erodeWithWater(grid: CellGrid, bounds: Bounds, config: ForestConfig): Set<number> {
  const water = planWater(grid, bounds, config.seed ^ 0x7a7e2, config.waterCoverage);
  for (const i of water) setOpen(grid, gridX(grid, i), gridY(grid, i), true);
  return water;
}
