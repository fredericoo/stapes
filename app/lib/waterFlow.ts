import {
  changedCellsOnLevel,
  getStack,
  setStacks,
  type StackEdit,
  tileIdsInChunk,
} from "./mapData";
import { StackPool } from "./stackPool";
import {
  type ChunkCells,
  type MapFile,
  type PlacedTile,
  type TileDef,
  parseCoordKey,
} from "./types";

/**
 * `flow` is stored modulo this many cells, so a placement takes one of
 * `FLOW_PERIOD * FLOW_STEPS_PER_CELL` values and the stack pool still shares
 * stacks of open water. Every `colorCycle.cellsPerCycle` has to divide it, or
 * a cycle jumps where the stored value wraps.
 */
export const FLOW_PERIOD = 16;
export const FLOW_STEPS_PER_CELL = 8;

/**
 * A colour-cycled liquid on a translucent sheet, laid over water, fades out
 * over this many cells in from the edge of its pool, so every cell that close
 * to the edge needs a tile under it to show through.
 */
export const LIQUID_FADE_CELLS = 2;

/** Open water this many cells from any bank is sea if it reaches the map's edge. */
const SEA_CLEARANCE = 4;
/** Narrow water this close to the sea is an inlet, so the sea's waves run into it. */
const INLET_REACH = 12;
/** Sea waves cross a cell in this many units of flow time. */
const SEA_PACE = 1.6;
/** A river crossing a cell `d` cells from its nearer bank takes `d / RIVER_SPEED` units, within the bounds below. */
const RIVER_SPEED = 2.5;
const RIVER_FASTEST = 0.6;
const RIVER_SLOWEST = 1.6;
/** A drop of a level is a fall, crossed in this share of a level step's time. */
const FALL_SHARE = 0.25;
/** Flow time added per cell an outlet lies north of the southernmost one, so a river leaves by its southern mouth. */
const SOUTHWARD_BIAS = 1;
/** A still pond drifts south, one cell per this many units. */
const POND_PACE = 2;
/** How many levels up or down a river may step into the next cell, over a fall. */
const FALL_REACH = 4;
/**
 * Water other than sea closer than these to its nearer bank draws two and
 * three waves where open water draws one, so a river's ripples are smaller
 * than the sea's.
 */
const TWO_WAVES_WITHIN = 3.5;
const THREE_WAVES_WITHIN = 1.5;
/**
 * `bank` is stored in whole cells up to this, past which the shader draws
 * open water the same, so the open sea is one value and its stacks are shared.
 */
export const BANK_CAP = 24;

export function colorCycleTileIds(tilesById: Record<string, TileDef>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const def of Object.values(tilesById)) if (def.colorCycle) ids.add(def.id);
  return ids;
}

export function wrapFlow(t: number): number {
  const steps = FLOW_PERIOD * FLOW_STEPS_PER_CELL;
  const q = Math.round(t * FLOW_STEPS_PER_CELL) % steps;
  return (q < 0 ? q + steps : q) / FLOW_STEPS_PER_CELL;
}

/** The difference `b - a` brought within half a period of zero. */
export function flowDelta(a: number, b: number): number {
  const d = (((b - a) % FLOW_PERIOD) + FLOW_PERIOD) % FLOW_PERIOD;
  return d > FLOW_PERIOD / 2 ? d - FLOW_PERIOD : d;
}

/** What water nobody has worked out a current for does: drifts south, as a pond does. */
export function driftFlow(y: number): number {
  return wrapFlow(y * POND_PACE);
}

/**
 * The cell's current: its colour-cycled placement's `flow`, or a southward
 * drift for one that has none, or null where nothing in the stack cycles.
 */
export function cellFlow(
  stack: readonly PlacedTile[],
  y: number,
  cycling: ReadonlySet<string>,
): number | null {
  let cycles = false;
  for (const placed of stack) {
    if (!cycling.has(placed.tileId)) continue;
    if (placed.flow !== undefined) return placed.flow;
    cycles = true;
  }
  return cycles ? driftFlow(y) : null;
}

const STEPS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * Knight's moves keep a front within a few percent of a circle; eight
 * steps alone draw it as an octagon. Each passes between the two cells it
 * crosses, which both have to be water.
 */
const KNIGHT_STEPS: ReadonlyArray<readonly [number, number, number]> = [
  [2, 1, Math.sqrt(5)],
  [2, -1, Math.sqrt(5)],
  [-2, 1, Math.sqrt(5)],
  [-2, -1, Math.sqrt(5)],
  [1, 2, Math.sqrt(5)],
  [1, -2, Math.sqrt(5)],
  [-1, 2, Math.sqrt(5)],
  [-1, -2, Math.sqrt(5)],
];

class Heap {
  private keys = new Float64Array(1024);
  private nodes = new Int32Array(1024);
  size = 0;

  push(node: number, key: number) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const nodes = new Int32Array(this.size * 2);
      nodes.set(this.nodes);
      this.nodes = nodes;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.keys[i] = this.keys[parent]!;
      this.nodes[i] = this.nodes[parent]!;
      i = parent;
    }
    this.keys[i] = key;
    this.nodes[i] = node;
  }

  /** The key of the node the last `pop` returned. */
  topKey = 0;

  pop(): number {
    const node = this.nodes[0]!;
    this.topKey = this.keys[0]!;
    const n = --this.size;
    const key = this.keys[n]!;
    const last = this.nodes[n]!;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.keys[child + 1]! < this.keys[child]!) child++;
      if (this.keys[child]! >= key) break;
      this.keys[i] = this.keys[child]!;
      this.nodes[i] = this.nodes[child]!;
      i = child;
    }
    this.keys[i] = key;
    this.nodes[i] = last;
    return node;
  }
}

type LevelGrid = { z: number; x0: number; y0: number; w: number; h: number; index: Int32Array };

/** Every cell holding a colour-cycled tile, as dense arrays, with a grid per level to find a cell's neighbours. */
export class WaterCells {
  readonly xs: Int32Array;
  readonly ys: Int32Array;
  readonly zs: Int32Array;
  readonly count: number;
  private readonly grids = new Map<number, LevelGrid>();
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;

  constructor(map: MapFile, cycling: ReadonlySet<string>) {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const zk in map.levels) {
      const z = Number(zk);
      if (!Number.isInteger(z)) continue;
      for (const chunk of Object.values(map.levels[zk]!)) {
        for (const ck in chunk) {
          const { x, y } = parseCoordKey(ck);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (!chunk[ck]!.some((p) => cycling.has(p.tileId))) continue;
          xs.push(x);
          ys.push(y);
          zs.push(z);
        }
      }
    }
    this.xs = Int32Array.from(xs);
    this.ys = Int32Array.from(ys);
    this.zs = Int32Array.from(zs);
    this.count = xs.length;
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;

    const bounds = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (let i = 0; i < this.count; i++) {
      const b = bounds.get(zs[i]!);
      if (!b) bounds.set(zs[i]!, { x0: xs[i]!, y0: ys[i]!, x1: xs[i]!, y1: ys[i]! });
      else {
        b.x0 = Math.min(b.x0, xs[i]!);
        b.y0 = Math.min(b.y0, ys[i]!);
        b.x1 = Math.max(b.x1, xs[i]!);
        b.y1 = Math.max(b.y1, ys[i]!);
      }
    }
    for (const [z, b] of bounds) {
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      this.grids.set(z, { z, x0: b.x0, y0: b.y0, w, h, index: new Int32Array(w * h).fill(-1) });
    }
    for (let i = 0; i < this.count; i++) {
      const g = this.grids.get(zs[i]!)!;
      g.index[(ys[i]! - g.y0) * g.w + (xs[i]! - g.x0)] = i;
    }
  }

  at(x: number, y: number, z: number): number {
    const g = this.grids.get(z);
    if (!g) return -1;
    const gx = x - g.x0;
    const gy = y - g.y0;
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return -1;
    return g.index[gy * g.w + gx]!;
  }

  inMap(x: number, y: number): boolean {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
  }

  onEdge(i: number): boolean {
    const x = this.xs[i]!;
    const y = this.ys[i]!;
    return x === this.minX || x === this.maxX || y === this.minY || y === this.maxY;
  }

  /**
   * The water in the next cell along `(dx, dy)`: on this level, or else the
   * nearest level within `FALL_REACH`, which is a river going over a fall.
   */
  step(i: number, dx: number, dy: number): { j: number; fall: boolean } | null {
    const x = this.xs[i]! + dx;
    const y = this.ys[i]! + dy;
    const z = this.zs[i]!;
    const level = this.at(x, y, z);
    if (level >= 0) return { j: level, fall: false };
    for (let d = 1; d <= FALL_REACH; d++) {
      const below = this.at(x, y, z - d);
      if (below >= 0) return { j: below, fall: true };
      const above = this.at(x, y, z + d);
      if (above >= 0) return { j: above, fall: true };
    }
    return null;
  }
}

/** Cells to the nearest cell on the same level that is in the map and holds no water. */
function bankDistance(cells: WaterCells): Float64Array {
  const d = new Float64Array(cells.count).fill(Infinity);
  const heap = new Heap();
  for (let i = 0; i < cells.count; i++) {
    for (const [dx, dy] of STEPS) {
      const x = cells.xs[i]! + dx;
      const y = cells.ys[i]! + dy;
      if (cells.inMap(x, y) && cells.at(x, y, cells.zs[i]!) < 0) {
        d[i] = 1;
        heap.push(i, 1);
        break;
      }
    }
  }
  while (heap.size > 0) {
    const i = heap.pop();
    if (heap.topKey > d[i]!) continue;
    for (const [dx, dy, len] of STEPS) {
      const j = cells.at(cells.xs[i]! + dx, cells.ys[i]! + dy, cells.zs[i]!);
      if (j < 0) continue;
      const next = d[i]! + len;
      if (next < d[j]!) {
        d[j] = next;
        heap.push(j, next);
      }
    }
  }
  return d;
}

/**
 * The sea is the water a disc of `SEA_CLEARANCE` cells can reach from the
 * map's edge without touching a bank, so a river too narrow for the disc is
 * not sea however it joins it. Narrow water whose far end is within
 * `INLET_REACH` of the sea is an inlet, and joins it.
 */
function seaCells(cells: WaterCells, bank: Float64Array): Uint8Array {
  const sea = new Uint8Array(cells.count);
  const queue: number[] = [];
  for (let i = 0; i < cells.count; i++) {
    if (cells.onEdge(i) && bank[i]! > SEA_CLEARANCE) {
      sea[i] = 1;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (const [dx, dy] of STEPS) {
      const j = cells.at(cells.xs[i]! + dx, cells.ys[i]! + dy, cells.zs[i]!);
      if (j < 0 || sea[j] || bank[j]! <= SEA_CLEARANCE) continue;
      sea[j] = 1;
      queue.push(j);
    }
  }

  const reach = new Float64Array(cells.count).fill(Infinity);
  const heap = new Heap();
  for (let i = 0; i < cells.count; i++) {
    if (sea[i]) {
      reach[i] = 0;
      heap.push(i, 0);
    }
  }
  while (heap.size > 0) {
    const i = heap.pop();
    if (heap.topKey > reach[i]!) continue;
    for (const [dx, dy, len] of STEPS) {
      const j = cells.at(cells.xs[i]! + dx, cells.ys[i]! + dy, cells.zs[i]!);
      if (j < 0) continue;
      const next = reach[i]! + len;
      if (next < reach[j]! && next <= SEA_CLEARANCE) {
        reach[j] = next;
        heap.push(j, next);
      }
    }
  }
  for (let i = 0; i < cells.count; i++) if (reach[i]! <= SEA_CLEARANCE) sea[i] = 1;

  const component = new Int32Array(cells.count).fill(-1);
  const members: number[][] = [];
  for (let start = 0; start < cells.count; start++) {
    if (sea[start] || component[start]! >= 0) continue;
    const id = members.length;
    const list = [start];
    component[start] = id;
    for (let k = 0; k < list.length; k++) {
      const i = list[k]!;
      for (const [dx, dy] of STEPS) {
        const next = cells.step(i, dx, dy);
        if (!next || sea[next.j] || component[next.j]! >= 0) continue;
        component[next.j] = id;
        list.push(next.j);
      }
    }
    members.push(list);
  }
  const fromSea = geodesicFrom(
    cells,
    (i) => !sea[i],
    (i) => touchesSea(cells, sea, i),
  );
  for (const list of members) {
    let far = 0;
    for (const i of list) far = Math.max(far, fromSea[i]!);
    if (far <= INLET_REACH) for (const i of list) sea[i] = 1;
  }
  return sea;
}

function touchesSea(cells: WaterCells, sea: Uint8Array, i: number): boolean {
  for (const [dx, dy] of STEPS) {
    const next = cells.step(i, dx, dy);
    if (next && sea[next.j]) return true;
  }
  return false;
}

/** Cells walked through `inside` from the cells `isSource` picks, or Infinity where none reaches. */
function geodesicFrom(
  cells: WaterCells,
  inside: (i: number) => boolean,
  isSource: (i: number) => boolean,
): Float64Array {
  const d = new Float64Array(cells.count).fill(Infinity);
  const heap = new Heap();
  for (let i = 0; i < cells.count; i++) {
    if (inside(i) && isSource(i)) {
      d[i] = 1;
      heap.push(i, 1);
    }
  }
  while (heap.size > 0) {
    const i = heap.pop();
    if (heap.topKey > d[i]!) continue;
    for (const [dx, dy, len] of STEPS) {
      const next = cells.step(i, dx, dy);
      if (!next || !inside(next.j)) continue;
      const t = d[i]! + len;
      if (t < d[next.j]!) {
        d[next.j] = t;
        heap.push(next.j, t);
      }
    }
  }
  return d;
}

/**
 * Time for the current to reach each cell from `sources`, through cells
 * `inside` accepts, where crossing cell `i` takes `pace(i)` per cell of
 * distance. Knight's moves are taken only on one level.
 */
function arrival(
  cells: WaterCells,
  inside: (i: number) => boolean,
  sources: ReadonlyArray<readonly [number, number]>,
  pace: (i: number) => number,
): Float64Array {
  const t = new Float64Array(cells.count).fill(Infinity);
  const heap = new Heap();
  for (const [i, start] of sources) {
    if (start < t[i]!) {
      t[i] = start;
      heap.push(i, start);
    }
  }
  while (heap.size > 0) {
    const i = heap.pop();
    if (heap.topKey > t[i]!) continue;
    const z = cells.zs[i]!;
    for (const [dx, dy, len] of STEPS) {
      const next = cells.step(i, dx, dy);
      if (!next || !inside(next.j)) continue;
      const j = next.j;
      const cost = len * 0.5 * (pace(i) + pace(j)) * (next.fall ? FALL_SHARE : 1);
      if (t[i]! + cost < t[j]!) {
        t[j] = t[i]! + cost;
        heap.push(j, t[j]!);
      }
    }
    for (const [dx, dy, len] of KNIGHT_STEPS) {
      const x = cells.xs[i]!;
      const y = cells.ys[i]!;
      const j = cells.at(x + dx, y + dy, z);
      if (j < 0 || !inside(j)) continue;
      const sx = Math.sign(dx);
      const sy = Math.sign(dy);
      const a = cells.at(x + sx, y + sy, z);
      const b = Math.abs(dx) === 2 ? cells.at(x + sx, y, z) : cells.at(x, y + sy, z);
      if (a < 0 || b < 0 || !inside(a) || !inside(b)) continue;
      const cost = len * 0.5 * (pace(i) + pace(j));
      if (t[i]! + cost < t[j]!) {
        t[j] = t[i]! + cost;
        heap.push(j, t[j]!);
      }
    }
  }
  return t;
}

/**
 * The current's time to every colour-cycled cell, in cells crossed at the
 * pace of one cell per unit. A cycle's bands move towards larger values.
 *
 * The sea's waves run in towards whatever is not sea, so they reach a coast
 * square on. A river runs to the sea by the shortest way through water, from
 * the southernmost mouth unless another is much nearer. Water that reaches no
 * sea drifts south.
 */
export function flowTimes(cells: WaterCells): {
  times: Float64Array;
  waves: Uint8Array;
  bank: Float64Array;
} {
  const bank = bankDistance(cells);
  const sea = seaCells(cells, bank);

  const seaSources: [number, number][] = [];
  for (let i = 0; i < cells.count; i++) {
    if (!sea[i]) continue;
    for (const [dx, dy] of STEPS) {
      const x = cells.xs[i]! + dx;
      const y = cells.ys[i]! + dy;
      if (!cells.inMap(x, y)) continue;
      const j = cells.at(x, y, cells.zs[i]!);
      if (j < 0 || !sea[j]) {
        seaSources.push([i, 0]);
        break;
      }
    }
  }
  const towardsShore = arrival(
    cells,
    (i) => sea[i] === 1,
    seaSources,
    () => SEA_PACE,
  );

  const riverPace = (i: number) =>
    Math.min(RIVER_SLOWEST, Math.max(RIVER_FASTEST, bank[i]! / RIVER_SPEED));
  const mouths: [number, number][] = [];
  for (let i = 0; i < cells.count; i++) {
    if (!sea[i] && touchesSea(cells, sea, i)) {
      mouths.push([i, (cells.maxY - cells.ys[i]!) * SOUTHWARD_BIAS]);
    }
  }
  const toMouth = arrival(cells, (i) => sea[i] === 0, mouths, riverPace);

  const t = new Float64Array(cells.count);
  const waves = new Uint8Array(cells.count).fill(1);
  for (let i = 0; i < cells.count; i++) {
    if (sea[i]) t[i] = -towardsShore[i]!;
    else if (Number.isFinite(toMouth[i]!)) t[i] = -toMouth[i]!;
    else t[i] = cells.ys[i]! * POND_PACE;
    if (!sea[i] && bank[i]! < THREE_WAVES_WITHIN) waves[i] = 3;
    else if (!sea[i] && bank[i]! < TWO_WAVES_WITHIN) waves[i] = 2;
  }
  return { times: t, waves, bank };
}

/**
 * Writes `flow`, `bank`, and `waves` where it is more than one, onto every
 * colour-cycled placement; built once per world, as it reads the whole map.
 */
export function withFlow(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  pool = new StackPool(),
): MapFile {
  const cycling = cyclingOf(tilesById);
  if (cycling.size === 0) return map;
  const cells = new WaterCells(map, cycling);
  const { times, waves, bank } = flowTimes(cells);
  const edits: StackEdit[] = [];
  for (let i = 0; i < cells.count; i++) {
    const x = cells.xs[i]!;
    const y = cells.ys[i]!;
    const z = cells.zs[i]!;
    const flow = wrapFlow(times[i]!);
    const stack = getStack(map, x, y, z);
    edits.push({
      x,
      y,
      z,
      stack: pool.share(
        stack.map((p) =>
          cycling.has(p.tileId)
            ? withCurrent(p, { flow, waves: waves[i]!, bank: storedBank(bank[i]!) })
            : p,
        ),
      ),
    });
  }
  return setStacks(map, edits);
}

type Current = { flow: number; waves: number; bank: number };

function storedBank(cells: number): number {
  return Math.min(BANK_CAP, Math.max(1, Math.round(cells)));
}

/** `waves` is left off at one and `bank` at `BANK_CAP`, which most of the sea is, to keep the map small. */
function withCurrent(placed: PlacedTile, { flow, waves, bank }: Current): PlacedTile {
  const { waves: _waves, bank: _bank, ...rest } = placed;
  return {
    ...rest,
    flow,
    ...(bank < BANK_CAP ? { bank } : {}),
    ...(waves > 1 ? { waves } : {}),
  };
}

/**
 * Cells from the cell's colour-cycled placement to the nearest bank. One with
 * a current and no `bank` is open water; one with neither is as close to a
 * bank as water gets, so water put down without a current still ripples.
 */
export function placedBank(placed: PlacedTile): number {
  return placed.bank ?? (placed.flow === undefined ? 1 : BANK_CAP);
}

export function cellBank(stack: readonly PlacedTile[], cycling: ReadonlySet<string>): number {
  for (const placed of stack) if (cycling.has(placed.tileId)) return placedBank(placed);
  return 1;
}

/** How many waves the cell's colour-cycled placement draws where open water draws one. */
export function cellWaves(stack: readonly PlacedTile[], cycling: ReadonlySet<string>): number {
  for (const placed of stack) if (cycling.has(placed.tileId)) return placed.waves ?? 1;
  return 1;
}

const cyclingByTiles = new WeakMap<Record<string, TileDef>, ReadonlySet<string>>();

function cyclingOf(tilesById: Record<string, TileDef>): ReadonlySet<string> {
  let ids = cyclingByTiles.get(tilesById);
  if (!ids) {
    ids = colorCycleTileIds(tilesById);
    cyclingByTiles.set(tilesById, ids);
  }
  return ids;
}

/**
 * Gives every colour-cycled placement `next` gained since `prev` that has no
 * `flow` (water put down after the world was built) the mean of its
 * neighbours', so it carries on their current; one with no such neighbour
 * drifts south. Only chunks that changed and hold such a tile are read, so a
 * step pays for nothing unless it was taken in water.
 */
export function settleFlow(
  prev: MapFile,
  next: MapFile,
  tilesById: Record<string, TileDef>,
): MapFile {
  if (prev === next) return next;
  const cycling = cyclingOf(tilesById);
  if (cycling.size === 0) return next;
  const holdsCycling = (chunk: ChunkCells | undefined) => {
    if (!chunk) return false;
    const ids = tileIdsInChunk(chunk);
    for (const id of cycling) if (ids.has(id)) return true;
    return false;
  };
  const edits: StackEdit[] = [];
  for (const zk in next.levels) {
    if (prev.levels[zk] === next.levels[zk]) continue;
    const z = Number(zk);
    for (const key of changedCellsOnLevel(prev, next, z, (_, b) => holdsCycling(b))) {
      const { x, y } = parseCoordKey(key);
      const stack = getStack(next, x, y, z);
      if (!stack.some((p) => cycling.has(p.tileId) && p.flow === undefined)) continue;
      const current = currentFromNeighbours(next, x, y, z, cycling);
      edits.push({
        x,
        y,
        z,
        stack: stack.map((p) =>
          cycling.has(p.tileId) && p.flow === undefined ? withCurrent(p, current) : p,
        ),
      });
    }
  }
  return edits.length > 0 ? setStacks(next, edits) : next;
}

function currentFromNeighbours(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  cycling: ReadonlySet<string>,
): Current {
  let anchor: number | null = null;
  let sum = 0;
  let waves = 0;
  let bank = 0;
  let n = 0;
  for (const [dx, dy] of STEPS) {
    const neighbour = getStack(map, x + dx, y + dy, z);
    if (!neighbour.some((p) => cycling.has(p.tileId) && p.flow !== undefined)) continue;
    const f = cellFlow(neighbour, y + dy, cycling)!;
    if (anchor === null) anchor = f;
    sum += anchor + flowDelta(anchor, f);
    waves += cellWaves(neighbour, cycling);
    bank += cellBank(neighbour, cycling);
    n++;
  }
  return n > 0
    ? { flow: wrapFlow(sum / n), waves: Math.round(waves / n), bank: storedBank(bank / n) }
    : { flow: driftFlow(y), waves: 1, bank: 1 };
}
