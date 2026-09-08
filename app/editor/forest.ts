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
  type Connection,
  type GeneratedPlan,
  type Rect,
  type ScatterRule,
  boundsOf,
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

/**
 * Two noise fields set how thick the wood is where you are standing, at two
 * sizes.
 *
 * **Where a wood is thick is not a property of where its edges are.** Density
 * that rises towards the rectangle makes the rectangle itself the only thing
 * varying, and what you get is a frame of solid trees around a clearing — the
 * shape of the tool rather than the shape of a wood. Two fields at different
 * sizes instead: `THICKET` decides which *parts* of the wood are close country
 * and which are open, and `CLUMP` puts stands and gaps inside each of them.
 */
const THICKET_SCALE = 17;
const THICKET_OCTAVES = 2;
const THICKET_SWING = 0.55;

const CLUMP_SCALE = 7;
const CLUMP_OCTAVES = 2;
const CLUMP_SWING = 0.4;

/**
 * Cells over which the trees dither out at the edge of the rectangle.
 *
 * **A wood should not end in a straight line.** The rectangle is how the wood
 * was asked for, not something about the wood, and trees that stop dead along
 * it read as a hedge somebody planted to a string. Ramping the chance down over
 * the last few cells scatters them out instead: fewer and fewer the closer to
 * the edge, so the boundary is ragged and two woods dragged next to each other
 * grow into one another.
 *
 * It ramps down to a *share* of the local density rather than to nothing.
 * Nothing is not a dither, it is a bare margin — a ring of empty ground four
 * cells wide, which is the rectangle showing through just as plainly as a wall
 * of trees would.
 */
const EDGE_DITHER = 5;
const EDGE_DITHER_FLOOR = 0.3;

/**
 * Chance a path strays instead of heading for the far side.
 *
 * **A path has to be walked, not plotted.** Offsetting a straight crossing by a
 * noise field gives a line that bends: it makes monotone progress along one
 * axis by construction, so a wood with one path in it is a wood with a
 * horizontal stripe through it. Walking to a mark on the far edge and straying
 * on the way lets the route double back, cross itself and arrive from an angle
 * — which is what a track through trees does.
 */
const PATH_STRAY_CHANCE = 0.38;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The cells one path covers, as grid indices.
 *
 * It is walked rather than plotted: from a point on one edge of the rectangle
 * to a point on the opposite one, straying as it goes. Both the axis and the
 * direction come from the seed, so a wood with one path in it is not always a
 * wood with an east-west path in it.
 *
 * The brush is a square of `width`, which is what keeps the route two cells
 * across in every direction however it turns — the corner of a two-wide
 * staircase belongs to no clear 2x2 square, and {@link widenToTwo} would plant
 * a tree in the path itself.
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
  const horizontal = random() < 0.5;
  const forward = random() < 0.5;

  const lastX = bounds.maxX - width + 1;
  const lastY = bounds.maxY - width + 1;
  if (lastX < bounds.minX || lastY < bounds.minY) return cells;
  const anyX = () => bounds.minX + Math.floor(random() * (lastX - bounds.minX + 1));
  const anyY = () => bounds.minY + Math.floor(random() * (lastY - bounds.minY + 1));

  const entry = horizontal ? (forward ? bounds.minX : lastX) : (forward ? bounds.minY : lastY);
  const exit = horizontal ? (forward ? lastX : bounds.minX) : (forward ? lastY : bounds.minY);
  const at = horizontal
    ? { x: entry, y: anyY() }
    : { x: anyX(), y: entry };
  const mark = horizontal
    ? { x: exit, y: anyY() }
    : { x: anyX(), y: exit };

  const stamp = (x: number, y: number) => {
    for (let dy = 0; dy < width; dy++) {
      for (let dx = 0; dx < width; dx++) {
        cells.add(gridIndex(g, x + dx, y + dy));
      }
    }
  };

  // Long enough for a strayed walk to arrive, short enough that one that never
  // does gives up rather than hanging the drag preview.
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
 * How far in a way-in from the wood next door is cut before it gives up.
 *
 * Shorter than a cave's, because a forest's edge is mostly walkable already —
 * usually the first cell or two is all that has a tree in it.
 */
const CONNECTION_DEPTH = 4;

/**
 * Cells a clearing needs before a track is cut to it from the path.
 *
 * Under it the clearing is left where it is, unreachable — a hollow in a
 * thicket, which is a thicket. Over it, somewhere you can see and cannot get
 * to reads as a mistake, so it gets a way in.
 */
export const MIN_GLADE_CELLS = 14;

/** How far a cell is from the nearest edge of the rectangle, in cells. */
function distanceFromEdge(bounds: Bounds, x: number, y: number): number {
  return Math.min(
    x - bounds.minX,
    bounds.maxX - x,
    y - bounds.minY,
    bounds.maxY - y,
  );
}

/** A field's swing about 1, so it multiplies the density rather than sets it. */
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
export function growForest(
  bounds: Bounds,
  config: ForestConfig,
  connections: readonly Connection[] = [],
): ForestShape {
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
    const thicket = swing(x, y, config.seed ^ 0x7471, THICKET_SCALE, THICKET_OCTAVES, THICKET_SWING);
    const clump = swing(x, y, config.seed ^ 0xc10b, CLUMP_SCALE, CLUMP_OCTAVES, CLUMP_SWING);
    const edge =
      EDGE_DITHER_FLOOR +
      (1 - EDGE_DITHER_FLOOR) *
        clamp01(distanceFromEdge(bounds, x, y) / EDGE_DITHER);
    const chance = density * fromPath * thicket * clump * edge;
    if (randomAt(x, y, config.seed) < chance) grid.cells[i] = 0;
  }

  // Where the rectangle meets ground of its own kind, a lane is cleared through
  // to it — that is what lets a big wood be dragged as several rectangles.
  const ways = new Set<number>();
  for (const connection of connections) {
    for (const i of openConnection(grid, bounds, connection, CONNECTION_DEPTH)) {
      ways.add(i);
    }
  }

  // Held to the cave's rule for the same reason: a gap one cell wide between
  // two trees is drawn over by the tree in front of it, so it is somewhere you
  // can walk and cannot see. Closing it here means planting a tree in it.
  widenToTwo(grid);
  for (const i of path) grid.cells[i] = 1;

  // A glade big enough to be worth walking to gets a track cut to it from the
  // path, which is what a wood with tracks in it looks like. The smaller ones
  // are left where they are: a hollow in a thicket you cannot quite get into is
  // a thicket, and planting them over instead is what turned the far half of a
  // dense wood into one solid block.
  // A way in from the wood next door counts as reachable exactly as a path
  // does: it is somewhere you can walk in from.
  joinRegions(grid, bounds, config.seed, {
    minRegionCells: MIN_GLADE_CELLS,
    tooSmall: "leave",
    home: (region) => region.some((i) => path.has(i) || ways.has(i)),
  });
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

  // **Where the rectangle meets ground of its own kind, it opens on to it.**
  // The path tile counts as well as the ground: a track running out of one
  // wood should meet the track running into the next.
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
