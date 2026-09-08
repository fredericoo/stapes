/**
 * The parts every procedural generator is built out of.
 *
 * A generator is a pure function from a map, a rectangle, a level and a
 * settings object to the list of {@link StackEdit}s that build the thing — or
 * to the reason it cannot be built. That contract is the whole of why the drag
 * preview and the commit cannot disagree: they call the same function. See
 * `docs/notes.md`, "A generator is a plan, and the plan is the preview".
 *
 * This module holds what more than one of them needs: the rectangle, the grid
 * of open cells they carve into, the noise they carve with, and the two
 * features — water and scattered props — that a cave and a forest decorate
 * their floors with in exactly the same way.
 */

import { getStack, type StackEdit } from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  HEIGHT_PER_LEVEL,
  isDirectional,
  physicalHeight,
  resolveWalkable,
} from "../lib/types";

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/** What every generator returns: the edits, or why there are none. */
export type GeneratedPlan =
  | { ok: true; edits: StackEdit[] }
  | { ok: false; reason: string };

/**
 * Both dimensions of any generator's footprint, so an accidental drag across
 * the world refuses cheaply rather than planning four thousand cells.
 */
export const MAX_FOOTPRINT = 64;

export function boundsOf(rect: Rect): Bounds {
  return {
    minX: Math.min(rect.x0, rect.x1),
    maxX: Math.max(rect.x0, rect.x1),
    minY: Math.min(rect.y0, rect.y1),
    maxY: Math.max(rect.y0, rect.y1),
  };
}

/** A placement of `tileId`, wearing `direction` only if the tile has faces. */
export function placed(
  tileId: string,
  tilesById: Record<string, TileDef>,
  direction?: Direction,
): PlacedTile {
  const def = tilesById[tileId];
  if (def && isDirectional(def)) {
    return { tileId, direction: direction ?? "s" };
  }
  return { tileId };
}

/**
 * A column of `tileId` exactly `units` tall, or why it cannot be one.
 *
 * A wall that does not reach the top of its level is a wall daylight and
 * arrows go over; one that passes it overflows into the level above. Rather
 * than round either way, the tile has to divide the height being filled —
 * which `half-stone` (two units) and a full-level block both do, and which is
 * the reason the wall pickers offer those and not the whole catalogue.
 */
export function columnOf(
  tileId: string,
  units: number,
  tilesById: Record<string, TileDef>,
): { ok: true; stack: PlacedTile[] } | { ok: false; reason: string } {
  const def = tilesById[tileId];
  if (!def) return { ok: false, reason: `There is no tile called ${tileId}` };
  const height = physicalHeight(def);
  if (height <= 0) {
    return { ok: false, reason: `${def.name} is flat, so it cannot be a wall` };
  }
  if (units % height !== 0) {
    return {
      ok: false,
      reason: `${def.name} stands ${height} units, which does not divide the ${units} being filled`,
    };
  }
  const stack: PlacedTile[] = [];
  for (let i = 0; i < units / height; i++) stack.push({ tileId });
  return { ok: true, stack };
}

/** Half a level, which is what a low wall along a cave's edge fills. */
export const HALF_LEVEL = HEIGHT_PER_LEVEL / 2;

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * Which cells of a footprint are open, in world coordinates.
 *
 * Every generator that carves works on one of these and reads it back at the
 * end: `cells[i]` is 1 where something may stand and 0 where it may not, which
 * for a cave is rock and for a forest is a tree.
 */
export type CellGrid = {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
};

export function newGrid(bounds: Bounds): CellGrid {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    width,
    height,
    cells: new Uint8Array(width * height),
  };
}

export function inGrid(g: CellGrid, x: number, y: number): boolean {
  return (
    x >= g.minX &&
    y >= g.minY &&
    x < g.minX + g.width &&
    y < g.minY + g.height
  );
}

export function gridIndex(g: CellGrid, x: number, y: number): number {
  return (y - g.minY) * g.width + (x - g.minX);
}

export function gridX(g: CellGrid, index: number): number {
  return (index % g.width) + g.minX;
}

export function gridY(g: CellGrid, index: number): number {
  return Math.floor(index / g.width) + g.minY;
}

export function isOpen(g: CellGrid, x: number, y: number): boolean {
  return inGrid(g, x, y) && g.cells[gridIndex(g, x, y)] === 1;
}

export function setOpen(g: CellGrid, x: number, y: number, open: boolean): void {
  if (inGrid(g, x, y)) g.cells[gridIndex(g, x, y)] = open ? 1 : 0;
}

/** Every open cell, in reading order. */
export function openCells(g: CellGrid): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === 1) out.push({ x: gridX(g, i), y: gridY(g, i) });
  }
  return out;
}

export function countOpen(g: CellGrid): number {
  let n = 0;
  for (let i = 0; i < g.cells.length; i++) n += g.cells[i]!;
  return n;
}

const ORTHOGONAL = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

/**
 * Cells reachable from each other by orthogonal steps, largest region first.
 *
 * `mask` defaults to the grid's own open cells; passing a different one is how
 * the water pass asks which parts of the floor are still dry *and* joined.
 */
export function regionsOf(g: CellGrid, mask?: Uint8Array): number[][] {
  const cells = mask ?? g.cells;
  const seen = new Uint8Array(cells.length);
  const regions: number[][] = [];
  const member = (x: number, y: number) =>
    inGrid(g, x, y) && cells[gridIndex(g, x, y)] === 1;

  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== 1 || seen[start]) continue;
    const region: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop()!;
      region.push(i);
      const x = gridX(g, i);
      const y = gridY(g, i);
      for (const { dx, dy } of ORTHOGONAL) {
        if (!member(x + dx, y + dy)) continue;
        const j = gridIndex(g, x + dx, y + dy);
        if (seen[j]) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    regions.push(region);
  }
  regions.sort((a, b) => b.length - a.length);
  return regions;
}

// ---------------------------------------------------------------------------
// Joining on to what is already there
// ---------------------------------------------------------------------------

/**
 * Whether the cell at `x,y` is ground of the kind this generator lays, and
 * clear enough to walk in from.
 *
 * **The floor has to be the top of the stack, not somewhere in it.** A cave's
 * rock stands on the same floor its cave does — see `planCave` — so a shell
 * cell contains the floor tile as surely as an open one does, and a test that
 * only asked whether the tile was present would read every wall as an
 * invitation. Anything standing on the floor is an obstruction for the same
 * reason: a bush is not a way in.
 */
export function isJoinableGround(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  z: number,
  floorTileIds: readonly string[],
): (x: number, y: number) => boolean {
  const ours = new Set(floorTileIds);
  return (x, y) => {
    const stack = getStack(map, x, y, z);
    const top = stack[stack.length - 1];
    if (!top || !ours.has(top.tileId)) return false;
    const def = tilesById[top.tileId];
    return def ? resolveWalkable(def) : false;
  };
}

/** A cell on the rectangle's border, and the way in from it. */
export type Connection = {
  x: number;
  y: number;
  inward: { dx: number; dy: number };
};

/**
 * Where the rectangle should open on to what is already around it.
 *
 * Each side is walked for runs of border cells whose outside neighbour is
 * ground you could step in from, and **each run gives one opening, at its
 * middle** rather than one per cell. Opening the whole run would take the
 * shell off a cave's entire flank, and would strip the dither off a forest's
 * edge — the point is a way through, not a missing side.
 */
export function connectionsAlongBorder(
  bounds: Bounds,
  joinable: (x: number, y: number) => boolean,
): Connection[] {
  const sides: Array<{
    /** Along the side, from `lo` to `hi`. */
    lo: number;
    hi: number;
    /** The border cell, and the cell outside it, for a position along the side. */
    border: (at: number) => { x: number; y: number };
    outside: (at: number) => { x: number; y: number };
    inward: { dx: number; dy: number };
  }> = [
    {
      lo: bounds.minX,
      hi: bounds.maxX,
      border: (at) => ({ x: at, y: bounds.minY }),
      outside: (at) => ({ x: at, y: bounds.minY - 1 }),
      inward: { dx: 0, dy: 1 },
    },
    {
      lo: bounds.minX,
      hi: bounds.maxX,
      border: (at) => ({ x: at, y: bounds.maxY }),
      outside: (at) => ({ x: at, y: bounds.maxY + 1 }),
      inward: { dx: 0, dy: -1 },
    },
    {
      lo: bounds.minY,
      hi: bounds.maxY,
      border: (at) => ({ x: bounds.minX, y: at }),
      outside: (at) => ({ x: bounds.minX - 1, y: at }),
      inward: { dx: 1, dy: 0 },
    },
    {
      lo: bounds.minY,
      hi: bounds.maxY,
      border: (at) => ({ x: bounds.maxX, y: at }),
      outside: (at) => ({ x: bounds.maxX + 1, y: at }),
      inward: { dx: -1, dy: 0 },
    },
  ];

  const out: Connection[] = [];
  for (const side of sides) {
    let runStart: number | null = null;
    for (let at = side.lo; at <= side.hi + 1; at++) {
      const here = at <= side.hi;
      const joined = here && joinable(side.outside(at).x, side.outside(at).y);
      if (joined && runStart === null) runStart = at;
      if (joined || runStart === null) continue;
      const middle = Math.floor((runStart + at - 1) / 2);
      out.push({ ...side.border(middle), inward: side.inward });
      runStart = null;
    }
  }
  return out;
}

/**
 * Cut a two-wide way in from `connection` until it meets open ground.
 *
 * Two wide for the reason everything here is two wide, and it stops as soon as
 * the cells ahead of it are already open so that joining on to a cave whose
 * floor reaches the shell costs one cell rather than a corridor. A run that
 * never meets anything stops at `maxDepth` and is left for {@link joinRegions},
 * which is why `maxDepth` wants to be deep enough that the stub is worth
 * joining rather than filling in.
 *
 * Returns the cells it opened, since a forest counts them as another way in
 * when it decides what is reachable.
 */
export function openConnection(
  g: CellGrid,
  bounds: Bounds,
  connection: Connection,
  maxDepth: number,
): number[] {
  const opened: number[] = [];
  const { dx, dy } = connection.inward;
  // The brush is anchored so both of its cells stay inside the rectangle.
  const anchor = (x: number, y: number) => ({
    x: Math.min(Math.max(x, bounds.minX), Math.max(bounds.minX, bounds.maxX - 1)),
    y: Math.min(Math.max(y, bounds.minY), Math.max(bounds.minY, bounds.maxY - 1)),
  });
  let { x, y } = connection;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const at = anchor(x, y);
    const met =
      depth > 0 &&
      isOpen(g, at.x, at.y) &&
      isOpen(g, at.x + 1, at.y) &&
      isOpen(g, at.x, at.y + 1) &&
      isOpen(g, at.x + 1, at.y + 1);
    for (const cell of [
      { x: at.x, y: at.y },
      { x: at.x + 1, y: at.y },
      { x: at.x, y: at.y + 1 },
      { x: at.x + 1, y: at.y + 1 },
    ]) {
      if (!inGrid(g, cell.x, cell.y)) continue;
      setOpen(g, cell.x, cell.y, true);
      opened.push(gridIndex(g, cell.x, cell.y));
    }
    if (met) return opened;
    x += dx;
    y += dy;
    if (!inGrid(g, x, y)) return opened;
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/**
 * Mixing constants from the usual 32-bit avalanche families, as in
 * `app/lib/scatter.ts` — named so the arithmetic reads as a hash.
 */
const X_MIX = 0x9e3779b1;
const Y_MIX = 0x85ebca6b;
const SEED_MIX = 0xc2b2ae35;
const AVALANCHE_A = 0x2c1b3c6d;
const AVALANCHE_B = 0x297a2d39;
const HIGH_SHIFT = 15;
const LOW_SHIFT = 12;
const UINT32 = 4294967296;

/** A well-mixed 32-bit value for one cell of one seed. */
export function hashCell(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, X_MIX) ^ Math.imul(y | 0, Y_MIX) ^ Math.imul(seed | 0, SEED_MIX);
  h ^= h >>> HIGH_SHIFT;
  h = Math.imul(h, AVALANCHE_A);
  h ^= h >>> LOW_SHIFT;
  h = Math.imul(h, AVALANCHE_B);
  return (h ^ (h >>> HIGH_SHIFT)) >>> 0;
}

/**
 * White noise in [0, 1) for one cell.
 *
 * Keyed on world coordinates rather than on a position within the rectangle,
 * so the pattern is anchored to the map: growing a drag reveals more of the
 * same cave rather than reshuffling the one already on screen.
 */
export function randomAt(x: number, y: number, seed: number): number {
  return hashCell(x, y, seed) / UINT32;
}

/** Deterministic PRNG for the passes that are a sequence rather than a field. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** Smoothstep, so a lattice of white noise interpolates without visible creases. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1]: white noise on a lattice of `scale` cells, interpolated. */
export function valueNoise(
  x: number,
  y: number,
  seed: number,
  scale: number,
): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = ease(fx - x0);
  const ty = ease(fy - y0);
  const n00 = randomAt(x0, y0, seed);
  const n10 = randomAt(x0 + 1, y0, seed);
  const n01 = randomAt(x0, y0 + 1, seed);
  const n11 = randomAt(x0 + 1, y0 + 1, seed);
  const top = n00 + (n10 - n00) * tx;
  const bottom = n01 + (n11 - n01) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Value noise summed over `octaves`, each half the size and half the weight of
 * the one before. Detail on top of shape, which is what stops a threshold of it
 * reading as a set of circles.
 */
export function fbm(
  x: number,
  y: number,
  seed: number,
  scale: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += valueNoise(x, y, seed + octave * 0x9e37, scale / 2 ** octave) * amplitude;
    total += amplitude;
    amplitude /= 2;
  }
  return sum / total;
}

// ---------------------------------------------------------------------------
// Two ground tiles wide, everywhere
// ---------------------------------------------------------------------------

/**
 * Close every passage narrower than two cells.
 *
 * **A one-cell passage is a passage you cannot see into.** The world is drawn
 * in an oblique projection, so the wall on the near side of a corridor is drawn
 * over the floor behind it — a corridor one cell wide is a corridor whose floor
 * is entirely hidden, and whatever is standing in it with it. Two cells is the
 * narrowest that leaves a visible strip.
 *
 * The rule that gets there is mechanical: an open cell has to be part of some
 * fully open 2x2 square. Anything else is a spur, a diagonal pinch or a
 * one-wide neck, and filling it in can expose a new one — so this runs to a
 * fixed point rather than once.
 */
export function widenToTwo(g: CellGrid): void {
  let changed = true;
  while (changed) {
    changed = false;
    const next = new Uint8Array(g.cells);
    for (let i = 0; i < g.cells.length; i++) {
      if (g.cells[i] !== 1) continue;
      const x = gridX(g, i);
      const y = gridY(g, i);
      const inSquare =
        squareOpen(g, x, y) ||
        squareOpen(g, x - 1, y) ||
        squareOpen(g, x, y - 1) ||
        squareOpen(g, x - 1, y - 1);
      if (!inSquare) {
        next[i] = 0;
        changed = true;
      }
    }
    g.cells.set(next);
  }
}

/** Whether the 2x2 square with its north-west corner at (x, y) is all open. */
function squareOpen(g: CellGrid, x: number, y: number): boolean {
  return (
    isOpen(g, x, y) &&
    isOpen(g, x + 1, y) &&
    isOpen(g, x, y + 1) &&
    isOpen(g, x + 1, y + 1)
  );
}

// ---------------------------------------------------------------------------
// Joining up what a carve left separate
// ---------------------------------------------------------------------------

/** Cells sampled from each region when looking for the closest pair to join. */
const JOIN_SAMPLES = 48;

/**
 * Fill in what is too small to be worth reaching, and join what is left.
 *
 * **Joining is done by opening, not by filling.** A cave that came out as three
 * rooms gets the passages that make it one cave, and a wood whose far side the
 * path cannot reach gets a track to it — rather than either of them losing the
 * part that ended up separate. What is genuinely too small to be worth a
 * corridor is filled back in instead, because a room reached down a long bored
 * passage that turns out to be a 2×2 closet is worse than no room.
 *
 * `home` picks which region the others are joined *to*; by default the largest.
 * A forest passes the one its path runs through, since that is what "reachable"
 * means there.
 */
export function joinRegions(
  g: CellGrid,
  box: Bounds,
  seed: number,
  minRegionCells: number,
  home?: (region: readonly number[]) => boolean,
): void {
  let regions = regionsOf(g);
  if (regions.length === 0) return;

  const homeIndex = home ? Math.max(0, regions.findIndex(home)) : 0;
  for (let n = 0; n < regions.length; n++) {
    if (n === homeIndex) continue;
    if (regions[n]!.length >= minRegionCells) continue;
    for (const i of regions[n]!) g.cells[i] = 0;
  }

  regions = regionsOf(g);
  const stillHome = home ? Math.max(0, regions.findIndex(home)) : 0;
  const random = mulberry32(seed ^ 0x30117);
  for (let n = 0; n < regions.length; n++) {
    if (n === stillHome) continue;
    const from = sample(regions[stillHome]!, random);
    const to = sample(regions[n]!, random);
    const pair = closestPair(g, from, to);
    if (pair) boreTunnel(g, box, pair.from, pair.to, random);
  }
}

function sample(region: readonly number[], random: () => number): number[] {
  if (region.length <= JOIN_SAMPLES) return region.slice();
  const out: number[] = [];
  for (let i = 0; i < JOIN_SAMPLES; i++) {
    out.push(region[Math.floor(random() * region.length)]!);
  }
  return out;
}

function closestPair(
  g: CellGrid,
  a: readonly number[],
  b: readonly number[],
): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  let best: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  let bestDistance = Infinity;
  for (const i of a) {
    const from = { x: gridX(g, i), y: gridY(g, i) };
    for (const j of b) {
      const to = { x: gridX(g, j), y: gridY(g, j) };
      const distance = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { from, to };
      }
    }
  }
  return best;
}

/** A two-wide L between two cells, turning at a corner picked by the seed. */
function boreTunnel(
  g: CellGrid,
  box: Bounds,
  from: { x: number; y: number },
  to: { x: number; y: number },
  random: () => number,
): void {
  const acrossFirst = random() < 0.5;
  const corner = acrossFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  boreLine(g, box, from, corner);
  boreLine(g, box, corner, to);
}

function boreLine(
  g: CellGrid,
  box: Bounds,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  const stepX = Math.sign(to.x - from.x);
  const stepY = Math.sign(to.y - from.y);
  let { x, y } = from;
  for (let guard = 0; guard <= g.cells.length; guard++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const cx = Math.min(box.maxX, Math.max(box.minX, x + dx));
        const cy = Math.min(box.maxY, Math.max(box.minY, y + dy));
        setOpen(g, cx, cy, true);
      }
    }
    if (x === to.x && y === to.y) return;
    x += stepX;
    y += stepY;
  }
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * Share of a water budget spent on basins rather than on streams.
 *
 * Streams are what water underground mostly is — something that runs along the
 * floor of a passage and that you step over — and a floor that is a sixth
 * still water reads as a flooded cave rather than a cave with a stream in it.
 */
const BASIN_SHARE = 1 / 6;

/** Steps one stream runs for, before it either meets the edge or stops. */
const STREAM_LENGTH = { min: 5, max: 18 } as const;

/** Chance a stream carries straight on rather than turning at a step. */
const STREAM_STRAIGHTNESS = 0.72;

/** Radius of one basin, in cells. */
const BASIN_RADIUS = { min: 1, max: 3 } as const;

/** Tries per stream or basin before the budget is given up on as unspendable. */
const PLACEMENT_ATTEMPTS = 40;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

/**
 * Where the water goes: several streams and the occasional basin.
 *
 * **Water cuts its own channel.** It is laid over the area rather than over
 * what has already been carved, so a stream that runs into rock takes the rock
 * out — which is how water actually shapes a cave, and what stops the streams
 * reading as puddles that happen to sit in rooms somebody else dug. The caller
 * opens every cell this returns.
 *
 * The brush is 2x2 for the same reason a passage is never one cell wide: a
 * channel one cell across running east-west is drawn over by the wall in front
 * of it, and an invisible stream is not worth cutting. It also means the
 * eroded channel already satisfies {@link widenToTwo} and survives it.
 *
 * Returned as grid indices rather than written into the grid, because water is
 * *on* the floor rather than instead of it — the cell is still carved, still
 * lit and still part of the cave's shape.
 */
export function planWater(
  g: CellGrid,
  area: Bounds,
  seed: number,
  coveragePercent: number,
): Set<number> {
  const water = new Set<number>();
  const floor = openCells(g);
  if (floor.length === 0 || coveragePercent <= 0) return water;

  const budget = Math.round((floor.length * coveragePercent) / 100);
  if (budget <= 0) return water;
  const basinBudget = Math.round(budget * BASIN_SHARE);
  const random = mulberry32(seed);
  // Streams start on floor that is already there — a stream has to come from
  // somewhere — and are free to wander into the rock from it.
  const source = () => floor[Math.floor(random() * floor.length)]!;
  const wet = (x: number, y: number) => {
    if (x < area.minX || x > area.maxX || y < area.minY || y > area.maxY) return;
    water.add(gridIndex(g, x, y));
  };
  const brush = (x: number, y: number) => {
    wet(x, y);
    wet(x + 1, y);
    wet(x, y + 1);
    wet(x + 1, y + 1);
  };

  for (
    let attempt = 0;
    attempt < PLACEMENT_ATTEMPTS && water.size < budget - basinBudget;
    attempt++
  ) {
    const start = source();
    let { x, y } = start;
    let step = STEPS[Math.floor(random() * STEPS.length)]!;
    const length =
      STREAM_LENGTH.min +
      Math.floor(random() * (STREAM_LENGTH.max - STREAM_LENGTH.min + 1));
    for (let i = 0; i < length; i++) {
      brush(x, y);
      if (random() > STREAM_STRAIGHTNESS) {
        step = STEPS[Math.floor(random() * STEPS.length)]!;
      }
      x += step.dx;
      y += step.dy;
      if (x < area.minX || x > area.maxX || y < area.minY || y > area.maxY) break;
    }
  }

  for (
    let attempt = 0;
    attempt < PLACEMENT_ATTEMPTS && water.size < budget;
    attempt++
  ) {
    const centre = source();
    const radius =
      BASIN_RADIUS.min +
      Math.floor(random() * (BASIN_RADIUS.max - BASIN_RADIUS.min + 1));
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Round rather than square: a basin is a pool, and the corners of a
        // square one are what make a scatter of them read as tiles.
        if (dx * dx + dy * dy > radius * radius) continue;
        wet(centre.x + dx, centre.y + dy);
      }
    }
  }

  return water;
}

/**
 * Take water back out wherever it has cut the floor in two.
 *
 * Water is `walkable: false`, so a stream one cell wide laid across a passage
 * two cells wide is a wall — and the half of the cave behind it is a place
 * nobody can reach. Rather than refuse to put water in narrow places, which
 * leaves streams as dashes rather than as streams, the floor is checked once
 * at the end and the shortest crossing back to each stranded part is dried
 * out. What that leaves on the map is a ford: a stream with stepping stones
 * where the passage needed them.
 *
 * **Done in one sweep rather than one per stranded piece.** A flood from every
 * dry cell at once labels each water cell with the piece of floor nearest it,
 * so wherever two labels meet is a candidate crossing and its length is
 * already known. Taking those cheapest-first and keeping track of what is
 * joined to what leaves the same result as reconnecting one piece at a time,
 * for one pass instead of one per piece — which at a full-size rectangle was
 * twenty-seven floods and most of the cost of planning a cave.
 */
export function cutFords(g: CellGrid, water: Set<number>): void {
  const dryMask = new Uint8Array(g.cells);
  for (const i of water) dryMask[i] = 0;
  const pieces = regionsOf(g, dryMask);
  if (pieces.length <= 1) return;

  // Flood outward from every piece of dry floor at once. `label` is the piece
  // a cell was reached from and `from` the step it was reached by, so a water
  // cell can walk itself back to dry land.
  const label = new Int32Array(g.cells.length).fill(-1);
  const from = new Int32Array(g.cells.length).fill(-1);
  const distance = new Int32Array(g.cells.length);
  const queue: number[] = [];
  pieces.forEach((piece, index) => {
    for (const i of piece) {
      label[i] = index;
      queue.push(i);
    }
  });

  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = gridX(g, i);
    const y = gridY(g, i);
    for (const { dx, dy } of STEPS) {
      if (!isOpen(g, x + dx, y + dy)) continue;
      const j = gridIndex(g, x + dx, y + dy);
      if (label[j] !== -1) continue;
      label[j] = label[i]!;
      from[j] = i;
      distance[j] = distance[i]! + 1;
      queue.push(j);
    }
  }

  type Crossing = { a: number; b: number; cost: number };
  const crossings: Crossing[] = [];
  for (let i = 0; i < g.cells.length; i++) {
    if (label[i] === -1) continue;
    const x = gridX(g, i);
    const y = gridY(g, i);
    // East and south only: every adjacent pair is then seen exactly once.
    for (const { dx, dy } of [
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
    ]) {
      if (!isOpen(g, x + dx, y + dy)) continue;
      const j = gridIndex(g, x + dx, y + dy);
      if (label[j] === label[i]) continue;
      crossings.push({ a: i, b: j, cost: distance[i]! + distance[j]! });
    }
  }
  crossings.sort((one, other) => one.cost - other.cost);

  const parent = pieces.map((_, index) => index);
  const find = (piece: number): number => {
    let root = piece;
    while (parent[root] !== root) root = parent[root]!;
    for (let step = piece; parent[step] !== root; ) {
      const next = parent[step]!;
      parent[step] = root;
      step = next;
    }
    return root;
  };

  let joined = 1;
  for (const crossing of crossings) {
    if (joined >= pieces.length) break;
    const a = find(label[crossing.a]!);
    const b = find(label[crossing.b]!);
    if (a === b) continue;
    parent[a] = b;
    joined++;
    dryPathHome(crossing.a, from, water);
    dryPathHome(crossing.b, from, water);
  }
}

/** Take the water off a cell and off every step back to dry land. */
function dryPathHome(cell: number, from: Int32Array, water: Set<number>): void {
  for (let step = cell; step !== -1 && water.has(step); step = from[step]!) {
    water.delete(step);
  }
}

// ---------------------------------------------------------------------------
// Scattered props
// ---------------------------------------------------------------------------

/**
 * A tile dropped on the floor here and there, and how often.
 *
 * The frequency is per cell rather than a count, so the same settings put the
 * same density of mushrooms in a small cave and a large one.
 */
export type ScatterRule = { tileId: string; chancePercent: number };

/** How many props one generator may be given. A form, not a spreadsheet. */
export const MAX_SCATTER_RULES = 4;

/**
 * Where each scattered prop lands.
 *
 * A cell takes at most one: two props in a stack is a pile rather than a
 * scatter, and the earlier rule wins so the list reads top to bottom. Rules
 * whose tile could not stand on the floor at all — taller than the level has
 * room for once the floor is under it — are dropped rather than planned and
 * refused, which is what "where they fit" means here.
 */
export function planScatter(
  cells: ReadonlyArray<{ x: number; y: number }>,
  rules: readonly ScatterRule[],
  seed: number,
  floorHeight: number,
  tilesById: Record<string, TileDef>,
): Map<string, string> {
  const out = new Map<string, string>();
  const usable = rules.filter((rule) => {
    const def = tilesById[rule.tileId];
    if (!def || rule.chancePercent <= 0) return false;
    return floorHeight + physicalHeight(def) <= HEIGHT_PER_LEVEL;
  });
  if (usable.length === 0) return out;

  for (const { x, y } of cells) {
    for (let r = 0; r < usable.length; r++) {
      const rule = usable[r]!;
      // A seed per rule, so raising one prop's frequency does not reshuffle
      // where the others landed.
      if (randomAt(x, y, seed + r * 0x1000193) * 100 >= rule.chancePercent) {
        continue;
      }
      out.set(`${x},${y}`, rule.tileId);
      break;
    }
  }
  return out;
}
