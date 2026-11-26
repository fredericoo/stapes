import { fbm, randomAt, type Bounds } from "../generator";
import { distanceTo } from "./distance";

export type WoodlandOptions = {
  seed: number;
  /** The share of the deep wood that is trees, 0 to 1, before the noise raises and lowers it. */
  density: number;
  /** How many cells in from the edge of its ground the wood takes to close to full density. */
  edge: number;
  /** The chance, 0 to 1, of a lone tree anywhere on its ground, however open. */
  outliers: number;
  /**
   * Cells the wood opens toward. When given, `edge` is counted from the nearest
   * of them or from the edge of `bounds` instead of from the end of the ground,
   * so the wood is thickest against whatever else ends its ground.
   */
  opensTo?: (x: number, y: number) => boolean;
};

/** What a cell of the wood's ground holds. */
export const OUTSIDE = 0;
export const OPEN = 1;
export const TREE = 2;

export type Woodland = {
  /** `OUTSIDE`, `OPEN` or `TREE` for each cell of the bounds, row by row. */
  cells: Uint8Array;
  /** How closed the canopy is meant to be at each cell, 0 at the very edge to 1 in the deep wood. */
  canopy: Float32Array;
};

const THICKET_SCALE = 17;
const THICKET_SWING = 0.3;
const CLUMP_SCALE = 6;
const CLUMP_SWING = 0.25;

/**
 * How far the wood's outline is pushed in or out, in edge bands, and how many
 * cells across its bays are. It is pushed in further than out, so the wood
 * rarely reaches full density right at the end of its ground.
 */
const EDGE_WOBBLE = 0.8;
const EDGE_PULL = 0.35;
const EDGE_SCALE_SHARE = 2.5;
const MIN_EDGE_SCALE = 6;
const EDGE_OCTAVES = 3;

/** Cells either side of a path where the trees thin, and the share of their chance they keep right beside it. */
const VERGE = 4;
const VERGE_FLOOR = 0.15;

/**
 * A tree is not planted beside this many trees already planted. The cells
 * before it in the scan are its west, north-west, north and north-east
 * neighbours, so two of them still allows a line but never a clump.
 */
const MAX_TREES_BESIDE = 2;

const TREE_STEP_COST = 4;
const TREE_STEP_SWING = 4;
const OPEN_STEP_COST = 1;

/** The neighbours a row-by-row scan has already reached. */
const BEFORE = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Plants a wood over the cells of `bounds` that `ground` allows. The chance of
 * a tree is the density, scaled by two noise fields of different sizes, by a
 * canopy that rises from nothing at the edge of the ground, or at the cells
 * it `opensTo`, to one `edge` cells in, and by a verge either side of `path`.
 * The edge is measured in a straight line and pushed in and out by noise, so
 * the wood ends in bays and tongues rather than in the shape of its frame,
 * and `outliers` puts lone trees in the open beyond it.
 *
 * No tree is planted beside more than `MAX_TREES_BESIDE` others, so the
 * trees stand apart rather than in clumps, and every open pocket that cannot
 * be walked into is joined to open ground outside or to the path by felling
 * the cheapest way there two cells wide.
 */
export function growWoodland(
  bounds: Bounds,
  ground: (x: number, y: number) => boolean,
  path: ReadonlySet<number>,
  options: WoodlandOptions,
): Woodland {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const n = width * height;
  const xOf = (i: number) => bounds.minX + (i % width);
  const yOf = (i: number) => bounds.minY + Math.floor(i / width);
  const cells = new Uint8Array(n);
  for (let i = 0; i < n; i++) cells[i] = ground(xOf(i), yOf(i)) ? OPEN : OUTSIDE;

  /** One cell of padding so the frame's own edge counts as the end of the ground. */
  const pw = width + 2;
  const opensTo = options.opensTo;
  const fromEdgePadded = distanceTo(pw, height + 2, (j) => {
    const x = (j % pw) - 1;
    const y = Math.floor(j / pw) - 1;
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    if (opensTo) return !inside || opensTo(bounds.minX + x, bounds.minY + y);
    return !inside || cells[y * width + x] === OUTSIDE;
  });
  const fromPath = path.size > 0 ? distanceTo(width, height, (i) => path.has(i)) : null;

  const treesBefore = (x: number, y: number) => {
    let trees = 0;
    for (const [dx, dy] of BEFORE) {
      const bx = x + dx - bounds.minX;
      const by = y + dy - bounds.minY;
      if (bx >= 0 && by >= 0 && bx < width && cells[by * width + bx] === TREE) trees++;
    }
    return trees;
  };
  const canopy = new Float32Array(n);
  const edgeScale = Math.max(MIN_EDGE_SCALE, options.edge * EDGE_SCALE_SHARE);
  for (let i = 0; i < n; i++) {
    if (cells[i] === OUTSIDE || path.has(i)) continue;
    const x = xOf(i);
    const y = yOf(i);
    const fromEdge = fromEdgePadded[(Math.floor(i / width) + 1) * pw + (i % width) + 1]!;
    let closed = 1;
    if (options.edge > 0) {
      const wobble =
        (fbm(x, y, options.seed ^ 0xed9e, edgeScale, EDGE_OCTAVES) - 0.5) * 2 * EDGE_WOBBLE -
        EDGE_PULL;
      closed = smooth((fromEdge - 0.5) / options.edge + wobble);
    }
    canopy[i] = closed;
    const thicket =
      1 + (fbm(x, y, options.seed ^ 0x7471, THICKET_SCALE, 2) - 0.5) * 2 * THICKET_SWING;
    const clump = 1 + (fbm(x, y, options.seed ^ 0xc10b, CLUMP_SCALE, 2) - 0.5) * 2 * CLUMP_SWING;
    const verge = fromPath
      ? VERGE_FLOOR + (1 - VERGE_FLOOR) * smooth((fromPath[i]! - 1) / VERGE)
      : 1;
    const chance = Math.max(options.density * closed * thicket * clump, options.outliers) * verge;
    if (randomAt(x, y, options.seed) < chance && treesBefore(x, y) < MAX_TREES_BESIDE) {
      cells[i] = TREE;
    }
  }

  const exit = opensTo ? (i: number) => opensTo(xOf(i), yOf(i)) : () => true;
  joinGlades(cells, width, height, path, options.seed, exit);
  return { cells, canopy };
}

/** A binary heap of cell indices ordered by `cost`. */
function heap(cost: Float64Array) {
  const items: number[] = [];
  const up = (k: number) => {
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (cost[items[parent]!]! <= cost[items[k]!]!) return;
      [items[parent], items[k]] = [items[k]!, items[parent]!];
      k = parent;
    }
  };
  const down = (k: number) => {
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < items.length && cost[items[l]!]! < cost[items[m]!]!) m = l;
      if (r < items.length && cost[items[r]!]! < cost[items[m]!]!) m = r;
      if (m === k) return;
      [items[m], items[k]] = [items[k]!, items[m]!];
      k = m;
    }
  };
  return {
    get size() {
      return items.length;
    },
    push(i: number) {
      items.push(i);
      up(items.length - 1);
    },
    pop(): number {
      const top = items[0]!;
      const last = items.pop()!;
      if (items.length > 0) {
        items[0] = last;
        down(0);
      }
      return top;
    },
  };
}

/**
 * Open ground counts as reached when it touches the path, the edge of the
 * bounds, or a cell beyond the ground that `exit` allows. Each glade that is
 * not, largest first, is joined to what is by the way that fells the fewest
 * trees, each tree costed with a little noise so the track bends round the
 * thick of the wood instead of running straight.
 */
function joinGlades(
  cells: Uint8Array,
  width: number,
  height: number,
  path: ReadonlySet<number>,
  seed: number,
  exit: (i: number) => boolean,
) {
  const n = cells.length;
  const region = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const reached: boolean[] = [];
  for (let start = 0; start < n; start++) {
    if (cells[start] !== OPEN || region[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    let home = false;
    const stack = [start];
    region[start] = id;
    while (stack.length > 0) {
      const i = stack.pop()!;
      size++;
      if (path.has(i)) home = true;
      const x = i % width;
      const y = Math.floor(i / width);
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          home = true;
          continue;
        }
        const j = ny * width + nx;
        if (cells[j] === OUTSIDE && exit(j)) home = true;
        if (cells[j] !== OPEN || region[j] !== -1) continue;
        region[j] = id;
        stack.push(j);
      }
    }
    sizes.push(size);
    reached.push(home);
  }

  const glades = sizes
    .map((size, id) => ({ size, id }))
    .filter((g) => !reached[g.id])
    .sort((a, b) => b.size - a.size || a.id - b.id);
  const stepCost = (i: number) =>
    cells[i] === TREE
      ? TREE_STEP_COST + randomAt(i % width, Math.floor(i / width), seed ^ 0x6a1d) * TREE_STEP_SWING
      : OPEN_STEP_COST;

  for (const glade of glades) {
    if (reached[glade.id]) continue;
    const cost = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const queue = heap(cost);
    for (let i = 0; i < n; i++) {
      if (region[i] !== glade.id) continue;
      cost[i] = 0;
      queue.push(i);
    }
    let end = -1;
    while (queue.size > 0) {
      const i = queue.pop();
      const r = region[i]!;
      if (r !== -1 && reached[r]) {
        end = i;
        break;
      }
      const x = i % width;
      const y = Math.floor(i / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        end = i;
        break;
      }
      for (const [dx, dy] of N4) {
        const j = (y + dy) * width + (x + dx);
        if (cells[j] === OUTSIDE) {
          if (!exit(j)) continue;
          end = i;
          break;
        }
        const next = cost[i]! + stepCost(j);
        if (next >= cost[j]!) continue;
        cost[j] = next;
        from[j] = i;
        queue.push(j);
      }
      if (end !== -1) break;
    }
    if (end === -1) continue;
    for (let i = end; i !== -1; i = from[i]!) {
      if (region[i] !== -1) reached[region[i]!] = true;
      const x = i % width;
      const y = Math.floor(i / width);
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const bx = Math.min(x + dx, width - 1);
          const by = Math.min(y + dy, height - 1);
          const j = by * width + bx;
          if (cells[j] === TREE) cells[j] = OPEN;
        }
      }
    }
    reached[glade.id] = true;
    const r = region[end]!;
    if (r !== -1) reached[r] = true;
  }
}
