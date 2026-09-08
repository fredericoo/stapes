/**
 * The forest generator: a rectangle of ground, a path through it, and trees
 * that thicken the further you get from the path.
 *
 * The path comes first and everything else is measured from it. That is the
 * whole idea — **a forest is a path and what grows either side of it**, not a
 * field of trees with a gap cut through afterwards. Planting first and clearing
 * second gives a corridor through noise; measuring from the path gives a route
 * that opens out where it runs and closes in where it does not.
 *
 * See `docs/notes.md`, "A forest is a path and what grows either side of it".
 */

import { getStack, isPlayerBody, setStacks, type StackEdit } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, physicalHeight, resolveActor } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import {
  MAX_FOOTPRINT,
  type Bounds,
  type CellGrid,
  type GeneratedPlan,
  type Rect,
  type ScatterRule,
  boundsOf,
  countOpen,
  cutFords,
  fbm,
  gridIndex,
  gridX,
  gridY,
  isOpen,
  joinRegions,
  mulberry32,
  newGrid,
  openCells,
  placed,
  planScatter,
  planWater,
  randomAt,
  regionsOf,
  setOpen,
  widenToTwo,
} from "./generator";

export type ForestConfig = {
  generator: "forest";
  /** Change it and the same rectangle grows a different forest. */
  seed: number;
  /** 0–100. How thick the trees get where they are thickest. */
  density: number;
  /** Laid under every cell of the rectangle. */
  groundTileId: string;
  /** The species. One tile, because a wood is usually one wood. */
  treeTileId: string;
  /** Routes cut through it, each running edge to edge. @see PATH_COUNT_RANGE */
  paths: number;
  /** Cells across. @see PATH_WIDTH_RANGE */
  pathWidth: number;
  /**
   * Laid on the ground along the path. `null` leaves the path as a clearing —
   * still a route, still what the trees are measured from, just not floored.
   */
  pathTileId: string | null;
  /** `null` for a dry wood. */
  waterTileId: string | null;
  /** 0–100. Share of the ground under water, mostly as streams. */
  waterCoverage: number;
  /** Bushes and the like, dropped between the trees. */
  scatter: ScatterRule[];
};

/** Room for a path and a few cells of wood either side of it. */
export const MIN_FOREST_FOOTPRINT = 8;

export const FOREST_DENSITY_RANGE = { min: 0, max: 100 } as const;

/**
 * Two is the floor for the same reason no cave passage is one cell wide: the
 * oblique projection draws the tree in front of a one-cell path over the path.
 */
export const PATH_WIDTH_RANGE = { min: 2, max: 6 } as const;

export const PATH_COUNT_RANGE = { min: 1, max: 3 } as const;

/**
 * Cells over which the wood thickens as you leave the path, as a share of the
 * rectangle's shorter side, and never fewer than this many.
 *
 * **Proportional, because otherwise the gradient is a band.** At a fixed six
 * cells, everything past a path's verges is at full density and a large wood is
 * a solid block with a corridor in it — the thinning is the whole point and it
 * has to be visible across the whole thing.
 */
const PATH_FALLOFF_SHARE = 0.4;
const MIN_PATH_FALLOFF = 6;

/** Cells across one lobe of the field that clumps the trees into stands. */
const CLUMP_SCALE = 9;
const CLUMP_OCTAVES = 2;

/**
 * How much the clumping field moves the local density either side of what the
 * distance from the path asks for. Without it the wood is an even scatter
 * whose density is a smooth function of one number, which reads as a gradient
 * rather than as trees.
 */
const CLUMP_SWING = 0.4;

/**
 * How much thicker the trees are at the rectangle's own edge, and how far in
 * that reaches.
 *
 * A wood you can see into from outside is a copse. This is what makes it read
 * as a wall of trees from the field next to it, with the path's two ends as the
 * way in.
 */
const EDGE_BOOST = 0.45;
const EDGE_REACH = 4;

/** How far a path wanders either side of its line, as a share of the crossing. */
const PATH_WANDER = 0.22;

/** Cells across one lobe of a path's wander. Long, so the path is not a wave. */
const PATH_WAVE_SCALE = 14;
const PATH_WAVE_OCTAVES = 2;

/** Where a path may be centred, as a share of the rectangle across its axis. */
const PATH_CENTRE_RANGE = { lo: 0.25, hi: 0.75 } as const;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The cells one path covers, as grid indices.
 *
 * It runs edge to edge — so the two ends are the way into the wood — and
 * wanders on the way with a noise field rather than a sine, which is the
 * difference between a path and a decorative squiggle.
 */
function carvePath(
  g: CellGrid,
  bounds: Bounds,
  seed: number,
  index: number,
  width: number,
): Set<number> {
  const cells = new Set<number>();
  const random = mulberry32((seed ^ 0x9a7e) + index * 0x9e37);
  const acrossX = index % 2 === 0;
  const alongLo = acrossX ? bounds.minX : bounds.minY;
  const alongHi = acrossX ? bounds.maxX : bounds.maxY;
  const acrossLo = acrossX ? bounds.minY : bounds.minX;
  const acrossHi = acrossX ? bounds.maxY : bounds.maxX;
  const span = acrossHi - acrossLo;
  if (span < width) return cells;

  const centre =
    acrossLo +
    span * lerp(PATH_CENTRE_RANGE.lo, PATH_CENTRE_RANGE.hi, random());
  const amplitude = span * PATH_WANDER;
  const half = Math.floor(width / 2);

  const band = (along: number): number => {
    const wave = fbm(
      along,
      index * 0x3d1,
      seed,
      PATH_WAVE_SCALE,
      PATH_WAVE_OCTAVES,
    );
    const at = Math.round(centre + (wave - 0.5) * 2 * amplitude);
    return clamp(at - half, acrossLo, acrossHi - width + 1);
  };
  const stamp = (along: number, lo: number) => {
    if (along < alongLo || along > alongHi) return;
    for (let step = 0; step < width; step++) {
      const across = lo + step;
      const x = acrossX ? along : across;
      const y = acrossX ? across : along;
      cells.add(gridIndex(g, x, y));
    }
  };

  // **Where the path steps sideways, both of its columns get both bands.**
  // A path that shifts across by one between two steps is a staircase, and the
  // outer corner of a staircase two cells wide belongs to no clear 2x2 square
  // — which is exactly the shape {@link widenToTwo} exists to close, so the
  // path would be planted over in its own corners. Giving the two columns the
  // union of their bands makes them identical where they meet, and identical
  // neighbouring columns of two or more cells are all in squares.
  let previous = band(alongLo);
  stamp(alongLo, previous);
  for (let along = alongLo + 1; along <= alongHi; along++) {
    const lo = band(along);
    stamp(along - 1, lo);
    stamp(along, previous);
    stamp(along, lo);
    previous = lo;
  }
  return cells;
}

/** Cells from each cell to the nearest path cell, by orthogonal steps. */
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
  return (
    x >= g.minX && y >= g.minY && x < g.minX + g.width && y < g.minY + g.height
  );
}

/**
 * Cells a clearing needs before a track is cut to it rather than it being
 * planted over.
 */
const MIN_GLADE_CELLS = 14;

/** How far a cell is from the nearest edge of the rectangle, in cells. */
function distanceFromEdge(bounds: Bounds, x: number, y: number): number {
  return Math.min(
    x - bounds.minX,
    bounds.maxX - x,
    y - bounds.minY,
    bounds.maxY - y,
  );
}

export type ForestShape = {
  /** Where you can walk: 1 is clear ground, 0 is a tree. */
  grid: CellGrid;
  /** The route, whether or not it is floored. */
  path: Set<number>;
};

/**
 * The forest's shape: its paths, and every cell a tree stands in.
 *
 * The chance of a tree is the distance from the path, lifted near the edges of
 * the rectangle and roughened by a noise field so the wood has stands and
 * glades in it rather than an even gradient. What that leaves is then held to
 * the same two rules a cave is: nothing you can walk through is one cell wide,
 * and everything you can walk to is reachable from the path.
 */
export function growForest(bounds: Bounds, config: ForestConfig): ForestShape {
  const grid = newGrid(bounds);
  grid.cells.fill(1);

  const path = new Set<number>();
  const paths = clamp(Math.round(config.paths), PATH_COUNT_RANGE.min, PATH_COUNT_RANGE.max);
  const width = clamp(
    Math.round(config.pathWidth),
    PATH_WIDTH_RANGE.min,
    PATH_WIDTH_RANGE.max,
  );
  for (let index = 0; index < paths; index++) {
    for (const i of carvePath(grid, bounds, config.seed, index, width)) {
      path.add(i);
    }
  }

  const distance = distanceFromPath(grid, path);
  const density = clamp01(config.density / 100);
  const falloff = Math.max(
    MIN_PATH_FALLOFF,
    Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) *
      PATH_FALLOFF_SHARE,
  );

  for (let i = 0; i < grid.cells.length; i++) {
    if (path.has(i)) continue;
    const x = gridX(grid, i);
    const y = gridY(grid, i);
    const fromPath = clamp01((distance[i] ?? falloff) / falloff);
    const fromEdge = clamp01(distanceFromEdge(bounds, x, y) / EDGE_REACH);
    const clump =
      1 + (fbm(x, y, config.seed ^ 0xc10b, CLUMP_SCALE, CLUMP_OCTAVES) - 0.5) * 2 * CLUMP_SWING;
    const chance =
      density * fromPath * clump * (1 + EDGE_BOOST * (1 - fromEdge));
    if (randomAt(x, y, config.seed) < chance) grid.cells[i] = 0;
  }

  // Held to the cave's rule for the same reason: a gap one cell wide between
  // two trees is drawn over by the tree in front of it, so it is somewhere you
  // can walk and cannot see. Closing it here means planting a tree in it.
  widenToTwo(grid);
  for (const i of path) grid.cells[i] = 1;

  // A glade walled in by trees is a place nobody can get to, which on the map
  // is indistinguishable from a mistake. The ones worth reaching get a track
  // cut to them from the path — which is what a wood with tracks in it looks
  // like — and the rest are planted over.
  const reachesPath = (region: readonly number[]) => region.some((i) => path.has(i));
  joinRegions(grid, bounds, config.seed, MIN_GLADE_CELLS, reachesPath);
  for (const region of regionsOf(grid)) {
    if (reachesPath(region)) continue;
    for (const i of region) grid.cells[i] = 0;
  }
  return { grid, path };
}

/**
 * The whole forest as one list of stack edits, or the reason it cannot be
 * grown.
 *
 * Like the cave and unlike the house, it **replaces** the level inside the
 * rectangle: the ground tile is laid under every cell rather than on top of
 * whatever was there, because a forest is ground as much as it is trees.
 */
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

  const { grid, path } = growForest(bounds, config);
  if (countOpen(grid) === 0) {
    return {
      ok: false,
      reason: "The forest closed over completely — lower the density",
    };
  }

  // Water takes out whatever it runs through, trees included, exactly as it
  // takes out a cave's rock: a stream does not stop at the tree line.
  const water = config.waterTileId
    ? erodeWithWater(grid, bounds, config)
    : new Set<number>();
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
      // The path is a covering laid over the ground, the way the town's roads
      // are `grass-2` with `cobblestone` on top of them.
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

/** Cut the water's channel through the wood, taking out the trees in its way. */
function erodeWithWater(
  grid: CellGrid,
  bounds: Bounds,
  config: ForestConfig,
): Set<number> {
  const water = planWater(grid, bounds, config.seed ^ 0x7a7e2, config.waterCoverage);
  for (const i of water) setOpen(grid, gridX(grid, i), gridY(grid, i), true);
  return water;
}
