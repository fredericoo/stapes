import { CellHeap, N4, N8, components, distanceTo, fbm, perlin, type Grid } from "./grid";
import { PLACES, ROADS, type PlaceId } from "./layout";
import { Mark, type Sketch } from "./sketch";

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
  seed: number;
  cellsPerPixel: number;
  /** The highest ground level, at the summit. */
  peakLevel: number;
  /** Cells of sea kept round the land; `docs/terrain.md` asks for at least 18. */
  seaRing: number;
};

const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** Samples the sketch's marks onto the cell grid by majority vote, then fills what labels and roads hid. */
function sampleMarks(sketch: Sketch, grid: Grid, cellsPerPixel: number): Uint8Array {
  const { width: w, height: h } = grid;
  const marks = new Uint8Array(w * h);
  const votes = new Uint16Array(8);
  const span = Math.max(1, Math.round(0.5 / cellsPerPixel));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      votes.fill(0);
      const px = Math.floor((x + 0.5) / cellsPerPixel);
      const py = Math.floor((y + 0.5) / cellsPerPixel);
      for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
          const sx = px + dx;
          const sy = py + dy;
          if (sx < 0 || sy < 0 || sx >= sketch.width || sy >= sketch.height) {
            votes[Mark.Sea]!++;
            continue;
          }
          votes[sketch.marks[sy * sketch.width + sx]!]!++;
        }
      }
      let best = Mark.Unknown;
      for (let m = 1; m < 8; m++) if (votes[m]! > votes[best]!) best = m;
      marks[y * w + x] = votes[best]! > 0 ? best : Mark.Unknown;
    }
  }
  for (let pass = 0; pass < 12; pass++) {
    let left = 0;
    const next = marks.slice();
    for (let i = 0; i < w * h; i++) {
      if (marks[i] !== Mark.Unknown) continue;
      votes.fill(0);
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        votes[marks[ny * w + nx]!]!++;
      }
      let best = Mark.Unknown;
      for (let m = 1; m < 8; m++) if (votes[m]! > votes[best]!) best = m;
      next[i] = best;
      if (best === Mark.Unknown) left++;
    }
    marks.set(next);
    if (left === 0) break;
  }
  return marks;
}

function largest(sizes: number[]): number {
  let best = 0;
  for (let l = 1; l < sizes.length; l++) if (sizes[l]! > (sizes[best] ?? 0)) best = l;
  return best;
}

function erode(grid: Grid, mask: Uint8Array, radius: number): Uint8Array {
  const d = distanceTo(grid, (i) => mask[i] === 0);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = d[i]! > radius ? 1 : 0;
  return out;
}

function dilate(grid: Grid, mask: Uint8Array, radius: number): Uint8Array {
  const d = distanceTo(grid, (i) => mask[i] === 1);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = d[i]! <= radius ? 1 : 0;
  return out;
}

export function buildIsland(sketch: Sketch, options: IslandOptions): Island {
  const { seed, cellsPerPixel: s, peakLevel, seaRing } = options;
  const w = Math.ceil(sketch.width * s);
  const h = Math.ceil(sketch.height * s);
  const grid = { width: w, height: h };
  const n = w * h;
  const marks = sampleMarks(sketch, grid, s);
  const at = (id: PlaceId) => ({
    x: Math.round(PLACES[id].x * s),
    y: Math.round(PLACES[id].y * s),
  });

  let wet: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) wet[i] = marks[i] === Mark.Water || marks[i] === Mark.Sea ? 1 : 0;
  wet = dilate(grid, erode(grid, wet, 3.2 * s * 2), 3.6 * s * 2);
  const dryParts = components(grid, (i) => wet[i] === 0);
  const minDry = 2500 * s * s * 4;
  for (let i = 0; i < n; i++) {
    if (!wet[i] && dryParts.sizes[dryParts.labels[i]!]! < minDry) wet[i] = 1;
  }
  const water = components(grid, (i) => wet[i] === 1);
  const sea = new Uint8Array(n);
  const border = new Set<number>();
  for (let x = 0; x < w; x++) {
    border.add(water.labels[x]!);
    border.add(water.labels[(h - 1) * w + x]!);
  }
  for (let y = 0; y < h; y++) {
    border.add(water.labels[y * w]!);
    border.add(water.labels[y * w + w - 1]!);
  }
  border.delete(0);
  for (let i = 0; i < n; i++) if (border.has(water.labels[i]!)) sea[i] = 1;

  const landish = components(grid, (i) => sea[i] === 0);
  const island = largest(landish.sizes);
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = landish.labels[i] === island ? 1 : 0;

  const lakes = new Uint8Array(n);
  for (let i = 0; i < n; i++) lakes[i] = land[i] && wet[i] ? 1 : 0;
  const lakeParts = components(grid, (i) => lakes[i] === 1);
  const minLake = 60 * s * s * 4;
  for (let i = 0; i < n; i++) {
    lakes[i] = lakeParts.labels[i] && lakeParts.sizes[lakeParts.labels[i]!]! >= minLake ? 1 : 0;
  }
  const bogAt = at("bog");
  const bogLabel = lakeParts.labels[bogAt.y * w + bogAt.x]!;

  let snow: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) snow[i] = marks[i] === Mark.Snow && land[i] ? 1 : 0;
  snow = erode(grid, dilate(grid, snow, 4 * s * 2), 4 * s * 2);
  const snowParts = components(grid, (i) => snow[i] === 1);
  const snowLabel = largest(snowParts.sizes);
  const desertParts = components(
    grid,
    (i) => (marks[i] === Mark.Desert || marks[i] === Mark.Lava) && land[i] === 1,
  );
  const desertLabel = largest(desertParts.sizes);
  let lava: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) lava[i] = marks[i] === Mark.Lava && land[i] ? 1 : 0;
  const gorge = dilate(grid, erode(grid, lava, 1), 1.5);
  lava = erode(grid, gorge, 3.2 * s * 2);

  const coast = distanceTo(grid, (i) => land[i] === 0);
  const seaDistance = distanceTo(grid, (i) => land[i] === 1);
  const snowDist = distanceTo(grid, (i) => snowParts.labels[i] === snowLabel);
  const snowInside = distanceTo(grid, (i) => snowParts.labels[i] !== snowLabel);
  const desertDist = distanceTo(grid, (i) => desertParts.labels[i] === desertLabel);
  const desertInside = distanceTo(grid, (i) => desertParts.labels[i] !== desertLabel);
  const lavaDist = distanceTo(grid, (i) => gorge[i] === 1);
  const bogDist = distanceTo(grid, (i) => lakeParts.labels[i] === bogLabel && bogLabel > 0);

  const noise = perlin(seed);
  const detail = perlin(seed + 1);
  const woodsNoise = perlin(seed + 2);
  const scale = 1 / s;
  const woodsCentre = { x: 300 * s, y: 560 * s };
  const woodsReach = 300 * s;

  const heightField = new Float32Array(n);
  const ground = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      ground[i] = seaDistance[i]! <= 4 ? Ground.Shallows : Ground.DeepSea;
      heightField[i] = -1;
      continue;
    }
    const x = i % w;
    const y = (i - x) / w;
    const nx = (x * scale) / 160;
    const ny = (y * scale) / 160;
    const rolling = fbm(noise, nx, ny, 4);
    const fine = fbm(detail, nx * 4, ny * 4, 3);
    const inland = smooth(2, 18, coast[i]!);

    const summit = snowParts.labels[i] === snowLabel;
    const mountain = summit
      ? peakLevel - 1.6 + Math.min(1.6, snowInside[i]! / (20 * s * 2))
      : (peakLevel - 1.8) * Math.pow(1 - smooth(0, 90 * s * 2, snowDist[i]!), 1.6);

    const inDesert = desertParts.labels[i] === desertLabel;
    const desertWeight = inDesert ? 1 : 1 - smooth(0, 14 * s * 2, desertDist[i]!);
    const gorgeWall = lavaDist[i]! < 2.5 ? -10 : 0;
    const rim = 2.6 * (1 - smooth(3, 22 * s * 2, lavaDist[i]!));
    const desert = 1.15 + 0.55 * rolling + rim + 0.3 * smooth(0, 30, desertInside[i]!) + gorgeWall;

    const wx = (x - woodsCentre.x) / woodsReach;
    const wy = (y - woodsCentre.y) / woodsReach;
    const woodsWeight =
      1 - smooth(0.55, 1.05, Math.sqrt(wx * wx + wy * wy) + 0.25 * woodsNoise(nx * 2, ny * 2));
    const bogBasin = 1 - smooth(4, 40 * s * 2, bogDist[i]!);
    const woods = (1.25 + 1.6 * rolling + 0.4 * fine) * (1 - bogBasin);

    const heart = 0.35 + 1.1 * rolling + 0.25 * fine;
    let base = heart * (1 - woodsWeight) + woods * woodsWeight;
    base = base * (1 - desertWeight) + desert * desertWeight;
    let height = inland * Math.max(base, mountain + 0.4 * fine);
    if (lakes[i]) height = -0.2;
    heightField[i] = height;
    if (lava[i] && inDesert) ground[i] = Ground.Lava;
    else if (lakes[i]) ground[i] = lakeParts.labels[i] === bogLabel ? Ground.Bog : Ground.Lake;
    else if (coast[i]! < 3 + 2 * fine) ground[i] = Ground.Beach;
    else if (summit) ground[i] = Ground.Snow;
    else if (inDesert || desertWeight > 0.5)
      ground[i] = lavaDist[i]! < 9 * s * 2 ? Ground.Basalt : Ground.Desert;
    else if (mountain > base + 0.3 && mountain > peakLevel * 0.45) ground[i] = Ground.Rock;
    else if (bogBasin > 0.55 && woodsWeight > 0.3) ground[i] = Ground.Bog;
    else if (woodsWeight > 0.72 + 0.1 * fine) ground[i] = Ground.DeepWoods;
    else if (woodsWeight > 0.35 + 0.15 * fine) ground[i] = Ground.Woods;
    else ground[i] = Ground.Grass;
  }

  const rivers = flowRivers(grid, heightField, land, lakes, s);
  for (let i = 0; i < n; i++) if (rivers[i] && ground[i] !== Ground.Lava) ground[i] = Ground.River;

  const level = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) level[i] = seaDistance[i]! <= seaRing ? 0 : -1;
    else if (ground[i] === Ground.Lake || ground[i] === Ground.Bog || ground[i] === Ground.Lava)
      level[i] = 0;
    else level[i] = Math.max(0, Math.floor(heightField[i]!));
  }
  settleLevels(grid, level, land, ground);
  lowerRivers(grid, level, ground);

  const dry = (i: number) =>
    level[i]! >= 0 &&
    ground[i] !== Ground.DeepSea &&
    ground[i] !== Ground.Shallows &&
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
 * Rain runs downhill: depressions are filled (priority flood from the sea,
 * so every land cell drains), each cell drains to its lowest neighbour, and a
 * cell is river once enough cells drain through it. Rivers start only on
 * ground above the lowlands, so they run off the hills into the lakes and sea.
 */
function flowRivers(
  grid: Grid,
  height: Float32Array,
  land: Uint8Array,
  lakes: Uint8Array,
  s: number,
): Uint8Array {
  const { width: w, height: h } = grid;
  const n = w * h;
  const filled = new Float32Array(n);
  const done = new Uint8Array(n);
  const order = new Int32Array(n);
  let count = 0;
  const heap = new CellHeap();
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      filled[i] = height[i]!;
      done[i] = 1;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && land[ny * w + nx]) {
          heap.push(i, filled[i]!);
          break;
        }
      }
    }
  }
  const downstream = new Int32Array(n).fill(-1);
  while (heap.size) {
    const i = heap.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (done[j]) continue;
      done[j] = 1;
      filled[j] = Math.max(height[j]!, filled[i]! + 1e-4);
      downstream[j] = i;
      order[count++] = j;
      heap.push(j, filled[j]!);
    }
  }
  const flow = new Float32Array(n).fill(1);
  for (let k = count - 1; k >= 0; k--) {
    const j = order[k]!;
    const d = downstream[j]!;
    if (d >= 0 && land[d] && !lakes[j]) flow[d]! += flow[j]!;
  }
  const threshold = 2600 * s * s;
  const rivers = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i] && !lakes[i] && flow[i]! > threshold) rivers[i] = 1;
  }
  const wide = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!rivers[i]) continue;
    wide[i] = 1;
    if (flow[i]! > threshold * 6) {
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && land[ny * w + nx]) wide[ny * w + nx] = 1;
      }
    }
  }
  return wide;
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
