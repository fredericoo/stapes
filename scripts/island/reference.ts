import { CellHeap } from "./grid";

/**
 * The terrain generator `docs/lore-map.webp` was drawn from (seed 75599),
 * ported from the planning page. It works on a 360 × 270 grid with centred
 * coordinates: `cx` in about -1.33..1.33, `cy` in -1..1, north up. One grid
 * cell is four sketch pixels.
 */
export const REF_W = 360;
export const REF_H = 270;
export const SKETCH_PIXELS_PER_REF_CELL = 4;

/** Lowest accumulated rain that makes a river, in grid cells of rain. */
export const RIVER_ACC = 336;

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(rng: () => number) {
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [base[i], base[j]] = [base[j]!, base[i]!];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255]!;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number) => {
    const g = h & 7;
    const u = g < 4 ? x : y;
    const v = g < 4 ? y : x;
    return (g & 1 ? -u : u) + (g & 2 ? -2 * v : 2 * v);
  };
  const noise = (x: number, y: number) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = fade(x);
    const v = fade(y);
    const a = p[X]! + Y;
    const b = p[X + 1]! + Y;
    const l1 = grad(p[a]!, x, y) + u * (grad(p[b]!, x - 1, y) - grad(p[a]!, x, y));
    const l2 =
      grad(p[a + 1]!, x, y - 1) + u * (grad(p[b + 1]!, x - 1, y - 1) - grad(p[a + 1]!, x, y - 1));
    return (l1 + v * (l2 - l1)) * 0.35;
  };
  const fbm = (x: number, y: number, octaves = 5) => {
    let s = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      s += amp * noise(x * f, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return s / norm;
  };
  const ridged = (x: number, y: number, octaves = 5) => {
    let s = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      s += amp * (1 - Math.abs(noise(x * f, y * f) * 2));
      norm += amp;
      amp *= 0.5;
      f *= 2.1;
    }
    return s / norm;
  };
  return { fbm, ridged };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (d2: number, r2: number) => Math.exp(-d2 / r2);
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

export type Sample = {
  /** Elevation; at or below 0 is sea. */
  e: number;
  /** How much of the Red Waste this is, 0..1. */
  east: number;
  /** How much of the Greenwood this is, 0..1. */
  forest: number;
  /** How much of the bog this is, 0..1. */
  bog: number;
  /** How near the gorge's line, 0..1. */
  gorge: number;
};

export type Reference = {
  /** The height and the land weights at any point, in grid coordinates (fractions allowed). */
  sample: (gx: number, gy: number) => Sample;
  elev: Float32Array;
  filled: Float32Array;
  /** 0 land, 1 sea, 2 lake, 3 lava. */
  water: Uint8Array;
  recv: Int32Array;
  acc: Float32Array;
  bogWeight: Float32Array;
  gorgeWeight: Float32Array;
};

const NB: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * `coast`, when given, overrides the generator's own coastline: it answers
 * whether a grid point is land, and the height is pushed just above or below
 * sea level to agree before anything floods or flows.
 */
export function generateReference(
  seed: number,
  coast?: (gx: number, gy: number) => boolean,
): Reference {
  const W = REF_W;
  const H = REF_H;
  const N = W * H;
  const rng = mulberry32(seed * 9973 + 17);
  const nz = makeNoise(rng);
  const off = [rng() * 100, rng() * 100, rng() * 100, rng() * 100] as const;
  const jitter = (s: number) => (rng() - 0.5) * s;
  const bay = { x: 0.42 + jitter(0.12), y: 0.7 };
  const peak = { x: jitter(0.25), y: -0.52 + jitter(0.06) };
  const lake = { x: peak.x + 0.08 + jitter(0.2), y: -0.12 + jitter(0.06) };
  const bog = { x: -0.72 + jitter(0.12), y: 0.28 + jitter(0.14) };
  const gorgePts: Array<[number, number]> = [];
  let gx = 0.66 + jitter(0.08);
  let gy = -0.4;
  for (let i = 0; i < 7; i++) {
    gorgePts.push([gx, gy]);
    gx += 0.04 + jitter(0.06);
    gy += 0.13 + jitter(0.03);
  }

  const sample = (x: number, y: number): Sample => {
    const cx = (x - W / 2) / (H / 2);
    const cy = (y - H / 2) / (H / 2);
    const warp = nz.fbm(cx * 1.5 + off[0], cy * 1.5 + off[1], 4);
    const d = Math.hypot(cx / 1.18, cy / 0.86) + warp * 0.32;
    const m = 1 - smooth(0.6, 1.0, d);
    let e = m * 0.3 - 0.07 + nz.fbm(cx * 3 + off[2], cy * 3 + off[3], 5) * 0.12 * m;
    e -= 0.45 * gauss((cx - bay.x) ** 2 * 1.3 + ((cy - bay.y) * 1.1) ** 2, 0.018);
    const g = gauss((cx - peak.x) ** 2 / 1.4 + ((cy - peak.y) * 1.25) ** 2, 0.09);
    e += 0.9 * g * (0.65 + 0.45 * nz.ridged(cx * 3.2 + 40, cy * 3.2 + 7, 5));
    e += 0.1 * m * Math.max(0, nz.ridged(cx * 2.2 + 13, cy * 2.2 + 91, 4) - 0.55) * 2.4;
    const east =
      smooth(0.28, 0.72, cx + nz.fbm(cx * 2 + 5, cy * 2 + 3, 3) * 0.3) *
      m *
      (1 - smooth(-0.25, -0.55, cy) * 0.6);
    e += 0.07 * east;
    let gd = 9;
    for (let k = 0; k < gorgePts.length - 1; k++) {
      const [ax, ay] = gorgePts[k]!;
      const [bx, by] = gorgePts[k + 1]!;
      gd = Math.min(gd, segDist(cx, cy, ax, ay, bx, by));
    }
    const gorge = gauss(gd * gd, 0.0012) * east;
    e -= 0.14 * gorge;
    e -= 0.17 * gauss((cx - lake.x) ** 2 + ((cy - lake.y) * 1.2) ** 2, 0.006) * m;
    const west = smooth(-0.1, -0.66, cx + nz.fbm(cx * 3 + 71, cy * 3 + 19, 4) * 0.7) * m;
    const forest = west * (1 - smooth(0.42, 0.55, e));
    const bw = gauss((cx - bog.x) ** 2 + ((cy - bog.y) * 1.2) ** 2, 0.03) * m;
    if (bw > 0.05) e = e * (1 - bw) + bw * (0.05 + 0.07 * nz.fbm(cx * 18 + 3, cy * 18 + 9, 3));
    if (e > 0) {
      e +=
        0.024 * nz.fbm(cx * 11 + 211, cy * 11 + 37, 3) * smooth(0, 0.05, e) +
        0.007 * nz.fbm(cx * 40 + 5, cy * 40 + 81, 2);
    }
    if (coast) {
      if (!coast(x, y)) e = Math.min(e, -0.02);
      else if (e < 0.006) e = 0.006 + 0.002 * nz.fbm(cx * 40 + 5, cy * 40 + 81, 2);
    }
    return { e, east, forest, bog: bw, gorge };
  };

  const elev = new Float32Array(N);
  const wE = new Float32Array(N);
  const wF = new Float32Array(N);
  const wB = new Float32Array(N);
  const gorge = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = sample(x, y);
      elev[i] = s.e;
      wE[i] = s.east;
      wF[i] = s.forest;
      wB[i] = s.bog;
      gorge[i] = s.gorge;
    }
  }

  const filled = new Float32Array(N);
  const seen = new Uint8Array(N);
  const heap = new CellHeap();
  for (let i = 0; i < N; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    if (elev[i]! <= 0 || x === 0 || y === 0 || x === W - 1 || y === H - 1) {
      filled[i] = elev[i]!;
      seen[i] = 1;
      heap.push(i, elev[i]!);
    }
  }
  while (heap.size) {
    const c = heap.pop();
    const cx = c % W;
    const cy = (c / W) | 0;
    for (const [dx, dy] of NB) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (seen[n]) continue;
      seen[n] = 1;
      filled[n] = Math.max(elev[n]!, filled[c]! + 1e-5);
      heap.push(n, filled[n]!);
    }
  }

  const water = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (elev[i]! <= 0) {
      water[i] = 1;
      continue;
    }
    const depth = filled[i]! - elev[i]!;
    const threshold = wB[i]! > 0.3 ? 0.004 : 0.018;
    if (depth > threshold) water[i] = gorge[i]! > 0.25 ? 3 : 2;
  }

  /** Water goes to a lower neighbour picked at random, weighted by the drop, so rivers wind on smooth slopes. */
  const recv = new Int32Array(N).fill(-1);
  const flowRng = mulberry32(seed * 31 + 5);
  const order: number[] = [];
  for (let i = 0; i < N; i++) {
    if (elev[i]! <= 0) continue;
    order.push(i);
    const x = i % W;
    const y = (i / W) | 0;
    let best = -1;
    let bestScore = -Infinity;
    for (const [dx, dy] of NB) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      const drop = filled[i]! - filled[n]!;
      if (drop <= 0) continue;
      const score = (drop / (dx && dy ? Math.SQRT2 : 1)) * (0.35 + flowRng());
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    recv[i] = best;
  }
  order.sort((a, b) => filled[b]! - filled[a]!);
  const acc = new Float32Array(N);
  for (const i of order) {
    const rain = (1 + 2.2 * Math.max(0, elev[i]!)) * (1 - 0.95 * wE[i]!) * (1 + 0.4 * wF[i]!);
    acc[i]! += rain;
    if (recv[i]! >= 0) acc[recv[i]!]! += acc[i]!;
  }
  return { sample, elev, filled, water, recv, acc, bogWeight: wB, gorgeWeight: gorge };
}
