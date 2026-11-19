import { CellHeap, N4, components, distanceTo, type Grid } from "./grid";
import { PLACES, ROADS, type PlaceId } from "./layout";
import { sketchLand, type Sketch } from "./sketch";
import {
  REF_H,
  REF_W,
  RIVER_ACC,
  SKETCH_PIXELS_PER_REF_CELL,
  generateReference,
  type Sample,
} from "./reference";

export const enum Ground {
  DeepSea = 0,
  Shallows = 1,
  Beach = 2,
  Grass = 3,
  Woods = 4,
  DeepWoods = 5,
  Bog = 6,
  Lake = 7,
  River = 8,
  Snow = 9,
  Rock = 10,
  Desert = 11,
  Basalt = 12,
  Lava = 13,
}

export const GROUND_NAMES = [
  "DeepSea",
  "Shallows",
  "Beach",
  "Grass",
  "Woods",
  "DeepWoods",
  "Bog",
  "Lake",
  "River",
  "Snow",
  "Rock",
  "Desert",
  "Basalt",
  "Lava",
] as const;

export type Island = Grid & {
  cellsPerPixel: number;
  /** Level of the ground's top in each cell; -1 is open sea outside the stored ring. */
  level: Int8Array;
  ground: Uint8Array;
  road: Uint8Array;
  /** Distance in cells to the nearest dry land. */
  seaDistance: Float32Array;
  place: (id: PlaceId) => { x: number; y: number };
  roadLengths: Array<{ from: PlaceId; to: PlaceId; cells: number }>;
};

export type IslandOptions = {
  /** The planning sketch, whose coastline the island keeps. */
  sketch: Sketch;
  seed: number;
  cellsPerPixel: number;
  /** The highest ground level, at the summit. */
  peakLevel: number;
  /** Cells of sea kept round the land; `docs/terrain.md` asks for at least 18. */
  seaRing: number;
};

function largest(sizes: number[]): number {
  let best = 0;
  for (let l = 1; l < sizes.length; l++) if (sizes[l]! > (sizes[best] ?? 0)) best = l;
  return best;
}

export function buildIsland(options: IslandOptions): Island {
  const { seed, cellsPerPixel: s, peakLevel, seaRing } = options;
  const sketch = options.sketch;
  const coastMask = sketchLand(sketch);
  const sketchCoast = (gx: number, gy: number) => {
    const px = Math.min(
      sketch.width - 1,
      Math.max(0, Math.floor((gx + 0.5) * SKETCH_PIXELS_PER_REF_CELL)),
    );
    const py = Math.min(
      sketch.height - 1,
      Math.max(0, Math.floor((gy + 0.5) * SKETCH_PIXELS_PER_REF_CELL)),
    );
    return coastMask[py * sketch.width + px] === 1;
  };
  const ref = generateReference(seed, sketchCoast);
  const k = s * SKETCH_PIXELS_PER_REF_CELL;
  const w = Math.ceil(REF_W * k);
  const h = Math.ceil(REF_H * k);
  const grid = { width: w, height: h };
  const n = w * h;
  const at = (id: PlaceId) => ({
    x: Math.round(PLACES[id].x * s),
    y: Math.round(PLACES[id].y * s),
  });
  const toRef = (c: number) => (c + 0.5) / k - 0.5;
  const filledAt = (gx: number, gy: number) => {
    const x0 = Math.max(0, Math.min(REF_W - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(REF_H - 2, Math.floor(gy)));
    const fx = Math.min(1, Math.max(0, gx - x0));
    const fy = Math.min(1, Math.max(0, gy - y0));
    const f = ref.filled;
    const i = y0 * REF_W + x0;
    const top = f[i]! * (1 - fx) + f[i + 1]! * fx;
    const bottom = f[i + REF_W]! * (1 - fx) + f[i + REF_W + 1]! * fx;
    return top * (1 - fy) + bottom * fy;
  };

  const samples = new Array<Sample>(n);
  const land = new Uint8Array(n);
  let maxE = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const sample = ref.sample(toRef(x), toRef(y));
      samples[i] = sample;
      if (sample.e > 0) {
        land[i] = 1;
        maxE = Math.max(maxE, sample.e);
      }
    }
  }
  const parts = components(grid, (i) => land[i] === 1);
  const island = largest(parts.sizes);
  for (let i = 0; i < n; i++) if (land[i] && parts.labels[i] !== island) land[i] = 0;
  const seaDistance = distanceTo(grid, (i) => land[i] === 1);
  const coast = distanceTo(grid, (i) => land[i] === 0);

  const ground = new Uint8Array(n);
  /** Low ground is kept low so that the hill columns, which cost a cell per storey, are spent on the peak. */
  const levelOf = (e: number) =>
    Math.max(
      0,
      Math.min(peakLevel, Math.floor(Math.pow(Math.max(0, e) / maxE, 1.3) * (peakLevel + 0.999))),
    );
  const level = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i - x) / w;
    const { e, east, forest, bog, gorge } = samples[i]!;
    if (!land[i]) {
      ground[i] = seaDistance[i]! <= 4 ? Ground.Shallows : Ground.DeepSea;
      level[i] = seaDistance[i]! <= seaRing ? 0 : -1;
      continue;
    }
    const depth = filledAt(toRef(x), toRef(y)) - e;
    const pond = depth > (bog > 0.3 ? 0.004 : 0.018);
    level[i] = levelOf(e);
    if (pond) {
      ground[i] = gorge > 0.25 ? Ground.Lava : bog > 0.3 ? Ground.Bog : Ground.Lake;
      level[i] = levelOf(filledAt(toRef(x), toRef(y)) - 0.02);
    } else if (coast[i]! < 2.5 && e < 0.05) ground[i] = Ground.Beach;
    else if (gorge > 0.8 && east > 0.3) ground[i] = Ground.Lava;
    else if (gorge > 0.12 && east > 0.3) ground[i] = Ground.Basalt;
    else if (east > 0.25) ground[i] = Ground.Desert;
    else if (bog > 0.3) ground[i] = Ground.Bog;
    else if (forest > 0.55) ground[i] = Ground.DeepWoods;
    else if (forest > 0.25) ground[i] = Ground.Woods;
    else if (e > 0.5) ground[i] = Ground.Snow;
    else if (e > 0.34) ground[i] = Ground.Rock;
    else ground[i] = Ground.Grass;
    if (ground[i] === Ground.Lava) level[i] = Math.max(0, levelOf(e) - 1);
  }

  for (let r = 0; r < REF_W * REF_H; r++) {
    const to = ref.recv[r]!;
    if (to < 0 || ref.acc[r]! <= RIVER_ACC || ref.water[r] || ref.gorgeWeight[r]! >= 0.3) continue;
    const width = ref.acc[r]! > RIVER_ACC * 16 ? 2 : ref.acc[r]! > RIVER_ACC * 4 ? 1 : 0;
    const ax = ((r % REF_W) + 0.5) * k;
    const ay = (Math.floor(r / REF_W) + 0.5) * k;
    const bx = ((to % REF_W) + 0.5) * k;
    const by = (Math.floor(to / REF_W) + 0.5) * k;
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
    for (let t = 0; t <= steps; t++) {
      const px = Math.floor(ax + ((bx - ax) * t) / steps);
      const py = Math.floor(ay + ((by - ay) * t) / steps);
      for (let dy = 0; dy <= width; dy++) {
        for (let dx = 0; dx <= width; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (
            land[i] &&
            ground[i] !== Ground.Lake &&
            ground[i] !== Ground.Lava &&
            ground[i] !== Ground.Bog
          ) {
            ground[i] = Ground.River;
          }
        }
      }
    }
  }

  settleLevels(grid, level, land, ground);
  lowerRivers(grid, level, ground);

  const dry = (i: number) =>
    level[i]! >= 0 &&
    land[i] === 1 &&
    ground[i] !== Ground.Lake &&
    ground[i] !== Ground.Bog &&
    ground[i] !== Ground.River &&
    ground[i] !== Ground.Lava;
  const snapped = new Map<PlaceId, { x: number; y: number }>();
  const place = (id: PlaceId) => {
    const known = snapped.get(id);
    if (known) return known;
    const want = at(id);
    let best = want;
    let bestD = Infinity;
    for (let dy = -40; dy <= 40; dy++) {
      for (let dx = -40; dx <= 40; dx++) {
        const x = want.x + dx;
        const y = want.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || !dry(y * w + x)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    snapped.set(id, best);
    return best;
  };

  const road = new Uint8Array(n);
  const roadLengths: Island["roadLengths"] = [];
  for (const [from, to] of ROADS) {
    const cells = routeRoad(grid, level, ground, road, place(from), place(to));
    roadLengths.push({ from, to, cells });
  }
  return { ...grid, cellsPerPixel: s, level, ground, road, seaDistance, place, roadLengths };
}

/**
 * Levels are storeys of cliff, so a terrace has to be wide enough to stand
 * on and a single cell standing proud of its neighbours is noise. A cell is
 * pulled to the level most of its neighbours are on until nothing moves.
 */
function settleLevels(grid: Grid, level: Int8Array, land: Uint8Array, ground: Uint8Array) {
  const { width: w, height: h } = grid;
  const counts = new Int32Array(32);
  for (let pass = 0; pass < 6; pass++) {
    let moved = 0;
    const next = level.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!land[i] || ground[i] === Ground.Lava) continue;
        counts.fill(0);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const l = level[ny * w + nx]!;
            if (l >= 0) counts[l]!++;
          }
        }
        let best = level[i]!;
        for (let l = 0; l < 32; l++) if (counts[l]! > counts[best]!) best = l;
        if (counts[level[i]!]! < 8 && best !== level[i]) {
          next[i] = best;
          moved++;
        }
      }
    }
    level.set(next);
    if (!moved) break;
  }
}

/** A river cell sits no higher than the cell it came from, so water never climbs a cliff. */
function lowerRivers(grid: Grid, level: Int8Array, ground: Uint8Array) {
  const { width: w, height: h } = grid;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < w * h; i++) {
      if (ground[i] !== Ground.River) continue;
      const x = i % w;
      const y = (i - x) / w;
      let low = level[i]!;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (ground[j] === Ground.River || ground[j] === Ground.Lake)
          low = Math.min(low, level[j]! + 1);
      }
      level[i] = Math.min(level[i]!, low);
    }
  }
}

/**
 * A* over the cells, four ways like a body walks: a step costs more uphill or across a cliff, a lot more
 * over water (a bridge), and is free-ish along a road already laid, so later
 * roads join the trunks instead of running beside them.
 */
function routeRoad(
  grid: Grid,
  level: Int8Array,
  ground: Uint8Array,
  road: Uint8Array,
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const { width: w, height: h } = grid;
  const n = w * h;
  const cost = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const heap = new CellHeap();
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  cost[start] = 0;
  heap.push(start, 0);
  const passable = (i: number) =>
    level[i]! >= 0 &&
    ground[i] !== Ground.DeepSea &&
    ground[i] !== Ground.Shallows &&
    ground[i] !== Ground.Lava &&
    ground[i] !== Ground.Lake;
  const closed = new Uint8Array(n);
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) break;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!passable(j) && j !== goal) continue;
      const climb = Math.abs(level[j]! - level[i]!);
      let step = 1;
      if (road[j]) step *= 0.35;
      if (climb) step += 14 * climb;
      if (ground[j] === Ground.River || ground[j] === Ground.Bog) step += 9;
      if (ground[j] === Ground.DeepWoods) step += 0.6;
      const next = cost[i]! + step;
      if (next < cost[j]!) {
        cost[j] = next;
        came[j] = i;
        const hx = Math.abs(nx - to.x);
        const hy = Math.abs(ny - to.y);
        heap.push(j, next + 0.35 * (hx + hy));
      }
    }
  }
  let cells = 0;
  for (let i = goal; i >= 0 && i !== start; i = came[i]!) {
    road[i] = 1;
    cells++;
  }
  road[start] = 1;
  return cells;
}
