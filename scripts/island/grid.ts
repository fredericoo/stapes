export type Grid = { width: number; height: number };

export const N4: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export const N8: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRADIENTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Gradient noise in about -1..1, from a permutation shuffled by `seed`. */
export function perlin(seed: number): (x: number, y: number) => number {
  const random = mulberry32(seed);
  const perm = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [base[i], base[j]] = [base[j]!, base[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255]!;
  const grad = (h: number, x: number, y: number) => {
    const g = GRADIENTS[h & 7]!;
    return g[0] * x + g[1] * y;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi]! + yi]!;
    const ab = perm[perm[xi]! + yi + 1]!;
    const ba = perm[perm[xi + 1]! + yi]!;
    const bb = perm[perm[xi + 1]! + yi + 1]!;
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return x1 + v * (x2 - x1);
  };
}

export function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * noise(x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

/**
 * Exact Euclidean distance from every cell to the nearest cell where `inside`
 * is set (Felzenszwalb and Huttenlocher's two-pass parabola envelope).
 */
export function distanceTo(grid: Grid, inside: (i: number) => boolean): Float32Array {
  const { width: w, height: h } = grid;
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const pass = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
    }
  };
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = inside(i) ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x]!;
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x]!;
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x]!;
  }
  const result = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) result[i] = Math.sqrt(out[i]!);
  return result;
}

/** Labels the 4-connected components of the cells where `member` is set; 0 is none. */
export function components(
  grid: Grid,
  member: (i: number) => boolean,
): { labels: Int32Array; sizes: number[] } {
  const { width: w, height: h } = grid;
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const queue = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || !member(start)) continue;
    const label = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (labels[n] || !member(n)) continue;
        labels[n] = label;
        queue[tail++] = n;
      }
    }
    sizes.push(tail);
  }
  return { labels, sizes };
}

/** A binary min-heap of cell indices keyed by a float priority. */
export class CellHeap {
  private keys: number[] = [];
  private cells: number[] = [];
  get size(): number {
    return this.cells.length;
  }
  push(cell: number, key: number): void {
    const keys = this.keys;
    const cells = this.cells;
    let i = cells.length;
    keys.push(key);
    cells.push(cell);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      cells[i] = cells[parent]!;
      i = parent;
    }
    keys[i] = key;
    cells[i] = cell;
  }
  pop(): number {
    const keys = this.keys;
    const cells = this.cells;
    const top = cells[0]!;
    const lastKey = keys.pop()!;
    const lastCell = cells.pop()!;
    const n = cells.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && keys[r]! < keys[l]! ? r : l;
      if (keys[c]! >= lastKey) break;
      keys[i] = keys[c]!;
      cells[i] = cells[c]!;
      i = c;
    }
    keys[i] = lastKey;
    cells[i] = lastCell;
    return top;
  }
  peekKey(): number {
    return this.keys[0]!;
  }
}
