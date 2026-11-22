/** Stands in for "no source": finite, so the parabola intersections stay numbers, and far past any grid's squared size. */
const FAR = 1e20;

/**
 * Squared distance from each sample to the lower envelope of the parabolas
 * rooted at `f`, the one-dimensional pass of Felzenszwalb and Huttenlocher's
 * exact distance transform. Run down every column and then along every row,
 * it gives the exact squared Euclidean distance.
 */
function envelope(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = 0;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * (q - p));
      if (s > z[k]!) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    out[q] = (q - p) * (q - p) + f[p]!;
  }
}

/**
 * The straight-line distance in cells from every cell of a `width` × `height`
 * grid to the nearest cell `source` is true for, Infinity when there is none.
 * Counting steps instead, four- or eight-neighbour, measures in diamonds or
 * squares, and every band drawn at a fixed distance from an edge then has
 * straight sides and corners.
 */
export function distanceTo(
  width: number,
  height: number,
  source: (index: number) => boolean,
): Float64Array {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = source(i) ? 0 : FAR;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]!;
    envelope(f, height, out, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = out[y]!;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x]!;
    envelope(f, width, out, v, z);
    for (let x = 0; x < width; x++)
      grid[y * width + x] = out[x]! >= FAR ? Infinity : Math.sqrt(out[x]!);
  }
  return grid;
}
