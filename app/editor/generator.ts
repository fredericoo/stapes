import { getStack, type StackEdit } from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, isDirectional, physicalHeight, resolveWalkable } from "../lib/types";

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

export type GeneratedPlan = { ok: true; edits: StackEdit[] } | { ok: false; reason: string };

export const MAX_FOOTPRINT = 64;

export function boundsOf(rect: Rect): Bounds {
  return {
    minX: Math.min(rect.x0, rect.x1),
    maxX: Math.max(rect.x0, rect.x1),
    minY: Math.min(rect.y0, rect.y1),
    maxY: Math.max(rect.y0, rect.y1),
  };
}

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

export const HALF_LEVEL = HEIGHT_PER_LEVEL / 2;

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

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function inGrid(g: CellGrid, x: number, y: number): boolean {
  return x >= g.minX && y >= g.minY && x < g.minX + g.width && y < g.minY + g.height;
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

export function regionsOf(g: CellGrid, mask?: Uint8Array): number[][] {
  const cells = mask ?? g.cells;
  const seen = new Uint8Array(cells.length);
  const regions: number[][] = [];
  const member = (x: number, y: number) => inGrid(g, x, y) && cells[gridIndex(g, x, y)] === 1;

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

export type Connection = {
  x: number;
  y: number;
  inward: { dx: number; dy: number };
};

export function connectionsAlongBorder(
  bounds: Bounds,
  joinable: (x: number, y: number) => boolean,
): Connection[] {
  const sides: Array<{
    lo: number;
    hi: number;
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

export function openConnection(
  g: CellGrid,
  bounds: Bounds,
  connection: Connection,
  maxDepth: number,
): number[] {
  const opened: number[] = [];
  const { dx, dy } = connection.inward;
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

const X_MIX = 0x9e3779b1;
const Y_MIX = 0x85ebca6b;
const SEED_MIX = 0xc2b2ae35;
const AVALANCHE_A = 0x2c1b3c6d;
const AVALANCHE_B = 0x297a2d39;
const HIGH_SHIFT = 15;
const LOW_SHIFT = 12;
const UINT32 = 4294967296;

export function hashCell(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, X_MIX) ^ Math.imul(y | 0, Y_MIX) ^ Math.imul(seed | 0, SEED_MIX);
  h ^= h >>> HIGH_SHIFT;
  h = Math.imul(h, AVALANCHE_A);
  h ^= h >>> LOW_SHIFT;
  h = Math.imul(h, AVALANCHE_B);
  return (h ^ (h >>> HIGH_SHIFT)) >>> 0;
}

export function randomAt(x: number, y: number, seed: number): number {
  return hashCell(x, y, seed) / UINT32;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x: number, y: number, seed: number, scale: number): number {
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

export function fbm(x: number, y: number, seed: number, scale: number, octaves: number): number {
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

function squareOpen(g: CellGrid, x: number, y: number): boolean {
  return isOpen(g, x, y) && isOpen(g, x + 1, y) && isOpen(g, x, y + 1) && isOpen(g, x + 1, y + 1);
}

export function stepTowards(
  from: { x: number; y: number },
  to: { x: number; y: number },
  random: () => number,
): { dx: number; dy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontal =
    Math.abs(dx) + Math.abs(dy) === 0
      ? random() < 0.5
      : random() * (Math.abs(dx) + Math.abs(dy)) < Math.abs(dx);
  if (horizontal) return { dx: Math.sign(dx) || 1, dy: 0 };
  return { dx: 0, dy: Math.sign(dy) || 1 };
}

const JOIN_SAMPLES = 48;

export function joinRegions(
  g: CellGrid,
  box: Bounds,
  seed: number,
  options: {
    minRegionCells: number;
    tooSmall: "fill" | "leave";
    home?: (region: readonly number[]) => boolean;
  },
): void {
  const { minRegionCells, tooSmall, home } = options;
  let regions = regionsOf(g);
  if (regions.length === 0) return;

  const homeIndex = home ? Math.max(0, regions.findIndex(home)) : 0;
  if (tooSmall === "fill") {
    for (let n = 0; n < regions.length; n++) {
      if (n === homeIndex) continue;
      if (regions[n]!.length >= minRegionCells) continue;
      for (const i of regions[n]!) g.cells[i] = 0;
    }
    regions = regionsOf(g);
  }

  const stillHome = home ? Math.max(0, regions.findIndex(home)) : 0;
  const random = mulberry32(seed ^ 0x30117);
  for (let n = 0; n < regions.length; n++) {
    if (n === stillHome) continue;
    if (regions[n]!.length < minRegionCells) continue;
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
    /**
     * The brush is clamped into the box, not each of its cells: clamping
     * cell by cell folds the far column onto the near one at the boundary
     * and leaves a corridor one cell wide there.
     */
    const bx = Math.min(Math.max(x, box.minX), Math.max(box.minX, box.maxX - 1));
    const by = Math.min(Math.max(y, box.minY), Math.max(box.minY, box.maxY - 1));
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        setOpen(g, Math.min(bx + dx, box.maxX), Math.min(by + dy, box.maxY), true);
      }
    }
    if (x === to.x && y === to.y) return;
    x += stepX;
    y += stepY;
  }
}

const BASIN_SHARE = 1 / 6;

const STREAM_LENGTH = { min: 5, max: 18 } as const;

const STREAM_STRAIGHTNESS = 0.72;

const BASIN_RADIUS = { min: 1, max: 3 } as const;

const PLACEMENT_ATTEMPTS = 40;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

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
      STREAM_LENGTH.min + Math.floor(random() * (STREAM_LENGTH.max - STREAM_LENGTH.min + 1));
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

  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && water.size < budget; attempt++) {
    const centre = source();
    const radius =
      BASIN_RADIUS.min + Math.floor(random() * (BASIN_RADIUS.max - BASIN_RADIUS.min + 1));
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        wet(centre.x + dx, centre.y + dy);
      }
    }
  }

  return water;
}

export function cutFords(g: CellGrid, water: Set<number>): void {
  const dryMask = new Uint8Array(g.cells);
  for (const i of water) dryMask[i] = 0;
  const pieces = regionsOf(g, dryMask);
  if (pieces.length <= 1) return;

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
    for (let step = piece; parent[step] !== root;) {
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

function dryPathHome(cell: number, from: Int32Array, water: Set<number>): void {
  for (let step = cell; step !== -1 && water.has(step); step = from[step]!) {
    water.delete(step);
  }
}

export type ScatterRule = { tileId: string; chancePercent: number };

export const MAX_SCATTER_RULES = 4;

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
      if (randomAt(x, y, seed + r * 0x1000193) * 100 >= rule.chancePercent) {
        continue;
      }
      out.set(`${x},${y}`, rule.tileId);
      break;
    }
  }
  return out;
}
