import { MAX_LIGHT_LEVEL } from "./types";

/**
 * How far east or west the sun bake looks for something in the way. It equals
 * the chunk bake's apron (`LIGHT_APRON`), so a chunk sees every occluder a
 * whole-map bake would and the two agree cell for cell.
 */
export const SUN_REACH = MAX_LIGHT_LEVEL;

export const SUN_SPAN_STRIDE = 2;

export const SUN_SPAN_NEVER_LO = 255;

export const SUN_SPAN_NEVER_HI = 0;

const SUN_SPAN_BYTE_MAX = 255;

const MIN_LIT_GAP_RAD = Math.PI / 360;

const SKY_LIT = 0.5;

/**
 * How far the sun's path leans south of straight overhead. It still rises due
 * east and sets due west, but at noon it stands this far towards the south, so
 * shadows swing from west through north to east over the day.
 */
export const SUN_TILT_RAD = (15 * Math.PI) / 180;

const SOUTH_PER_LEVEL = Math.tan(SUN_TILT_RAD);

const PATH_UP_PER_LEVEL = 1 / Math.cos(SUN_TILT_RAD);

export type SunGrid = {
  w: number;
  h: number;
  d: number;
  opacity: Float32Array;
  seals: Uint8Array;
  occupied: Uint8Array;
  sky: Float32Array;
};

type Scratch = { lo: Float64Array; hi: Float64Array; order: Int32Array; n: number };

function makeScratch(capacity: number): Scratch {
  return {
    lo: new Float64Array(capacity),
    hi: new Float64Array(capacity),
    order: new Int32Array(capacity),
    n: 0,
  };
}

function push(s: Scratch, lo: number, hi: number) {
  if (s.n === s.lo.length) {
    const grow = (a: Float64Array) => {
      const b = new Float64Array(a.length * 2);
      b.set(a);
      return b;
    };
    s.lo = grow(s.lo);
    s.hi = grow(s.hi);
    s.order = new Int32Array(s.lo.length);
  }
  s.lo[s.n] = lo;
  s.hi[s.n] = hi;
  s.n++;
}

/**
 * Elevation of a corner seen from the cell, 0 on the eastern horizon and π on
 * the western. A corner at or below the eye is pinned to the horizon on its
 * side, because the box it belongs to then reaches down to the horizon there.
 */
function cornerAngle(cornerX: number, cornerH: number, eyeX: number, eyeH: number): number {
  const rise = cornerH - eyeH;
  if (rise <= 0) return cornerX > eyeX ? 0 : Math.PI;
  return Math.atan2(rise * PATH_UP_PER_LEVEL, cornerX - eyeX);
}

/**
 * Only two corners of a box can bound the angles it hides: east of the eye
 * the far-bottom and near-top, west of it the near-top and far-bottom, and
 * straight overhead the two bottom corners.
 */
function pushBox(s: Scratch, x0: number, bottom: number, top: number, eyeX: number, eyeH: number) {
  if (x0 > eyeX) {
    push(s, cornerAngle(x0 + 1, bottom, eyeX, eyeH), cornerAngle(x0, top, eyeX, eyeH));
  } else if (x0 + 1 < eyeX) {
    push(s, cornerAngle(x0 + 1, top, eyeX, eyeH), cornerAngle(x0, bottom, eyeX, eyeH));
  } else {
    push(s, cornerAngle(x0 + 1, bottom, eyeX, eyeH), cornerAngle(x0, bottom, eyeX, eyeH));
  }
}

function widestGap(s: Scratch): [number, number] | null {
  const { lo, hi, order } = s;
  for (let i = 0; i < s.n; i++) order[i] = i;
  for (let i = 1; i < s.n; i++) {
    const k = order[i]!;
    let j = i - 1;
    while (j >= 0 && lo[order[j]!]! > lo[k]!) {
      order[j + 1] = order[j]!;
      j--;
    }
    order[j + 1] = k;
  }
  let covered = 0;
  let best: [number, number] | null = null;
  let bestWidth = MIN_LIT_GAP_RAD;
  for (let i = 0; i < s.n; i++) {
    const k = order[i]!;
    if (lo[k]! - covered > bestWidth) {
      best = [covered, lo[k]!];
      bestWidth = lo[k]! - covered;
    }
    if (hi[k]! > covered) covered = hi[k]!;
  }
  if (Math.PI - covered > bestWidth) best = [covered, Math.PI];
  return best;
}

function encodeAngle(rad: number): number {
  return Math.round((rad / Math.PI) * SUN_SPAN_BYTE_MAX);
}

/**
 * The row a ray from the eye is passing over at height `h`. Every ray towards
 * a sun on the tilted path drifts south by the same amount per level climbed,
 * so a cell's rays all lie in one sheared plane, and the bake is still a 2D
 * problem per cell — it just reads each level from a different row.
 */
function rowAt(eyeRowY: number, eyeH: number, h: number): number {
  return Math.floor(eyeRowY + SOUTH_PER_LEVEL * (h - eyeH));
}

/**
 * The highest top in each column over the rows south of it that a ray can
 * drift into before it climbs past the domain, so a column with nothing above
 * the eye is skipped without walking its levels.
 */
function topsSouthward(g: SunGrid, tops: Float32Array): Float32Array {
  const drift = Math.ceil(SOUTH_PER_LEVEL * g.d) + 1;
  const out = new Float32Array(tops.length);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      let highest = -Infinity;
      for (let dy = 0; dy <= drift && y + dy < g.h; dy++) {
        const top = tops[(y + dy) * g.w + x]!;
        if (top > highest) highest = top;
      }
      out[y * g.w + x] = highest;
    }
  }
  return out;
}

function columnTops(g: SunGrid): Float32Array {
  const slice = g.w * g.h;
  const tops = new Float32Array(slice).fill(-Infinity);
  for (let lz = 0; lz < g.d; lz++) {
    for (let col = 0; col < slice; col++) {
      const i = lz * slice + col;
      if (!g.seals[i]) continue;
      const top = lz + Math.min(1, g.opacity[i]!);
      if (top > tops[col]!) tops[col] = top;
    }
  }
  return tops;
}

/**
 * For every occupied, sky-lit cell, the widest span of the sun's east-to-west
 * arc from which a parallel ray reaches it. The arc leans south by
 * {@link SUN_TILT_RAD}, so every ray from one cell lies in one plane (see
 * `rowAt`), and each level is read from the row where the ray enters it. That
 * keeps the cell a 2D problem in (x, height along the plane): every solid box
 * and floor above it hides an interval of angles, and the cell is sunlit
 * wherever the union of those leaves a gap. A cell lit through two separate openings keeps
 * only the wider one.
 *
 * Anything beyond {@link SUN_REACH} is unknown, so the column at the end of
 * the reach stands in for it as a wall as tall as its highest floor. Without
 * it a low sun would slip under a cave's roof, run past the end of the reach
 * still underground, and light the cave.
 */
export function bakeSunSpans(g: SunGrid): Uint8Array {
  const slice = g.w * g.h;
  const out = new Uint8Array(slice * g.d * SUN_SPAN_STRIDE);
  for (let i = 0; i < slice * g.d; i++) {
    out[i * SUN_SPAN_STRIDE] = SUN_SPAN_NEVER_LO;
    out[i * SUN_SPAN_STRIDE + 1] = SUN_SPAN_NEVER_HI;
  }
  const tops = columnTops(g);
  const reachable = topsSouthward(g, tops);
  const scratch = makeScratch(64);

  for (let lz = 0; lz < g.d; lz++) {
    for (let ly = 0; ly < g.h; ly++) {
      for (let lx = 0; lx < g.w; lx++) {
        const i = lz * slice + ly * g.w + lx;
        if (!g.occupied[i] || g.sky[i]! <= SKY_LIT) continue;
        const gap = litGap(g, tops, reachable, scratch, lx, ly, lz);
        if (!gap) continue;
        out[i * SUN_SPAN_STRIDE] = encodeAngle(gap[0]);
        out[i * SUN_SPAN_STRIDE + 1] = encodeAngle(gap[1]);
      }
    }
  }
  return out;
}

function litGap(
  g: SunGrid,
  tops: Float32Array,
  reachable: Float32Array,
  s: Scratch,
  lx: number,
  ly: number,
  lz: number,
): [number, number] | null {
  const slice = g.w * g.h;
  const eyeRowY = ly + 0.5;
  const eyeX = lx + 0.5;
  const eyeH = lz + Math.min(1, g.opacity[lz * slice + ly * g.w + lx]!);
  s.n = 0;

  const xFrom = Math.max(0, lx - SUN_REACH);
  const xTo = Math.min(g.w - 1, lx + SUN_REACH);
  for (let cx = xFrom; cx <= xTo; cx++) {
    const highest = reachable[ly * g.w + cx]!;
    if (highest <= eyeH) continue;
    const czTo = Math.min(g.d - 1, Math.ceil(highest));
    let runBottom = -1;
    let runTop = -1;
    let runRow = -1;
    for (let cz = Math.floor(eyeH); cz <= czTo; cz++) {
      const cy = rowAt(eyeRowY, eyeH, Math.max(cz, eyeH));
      if (cy >= g.h) break;
      const j = cz * slice + cy * g.w + cx;
      const solid =
        tops[cy * g.w + cx]! >= cz && g.seals[j] && !(cx === lx && cy === ly && cz === lz);
      const top = cz + Math.min(1, g.opacity[j]!);
      if (solid && top > eyeH && runTop === cz && runRow === cy) {
        runTop = top;
        continue;
      }
      if (runTop > eyeH) pushBox(s, cx, Math.max(runBottom, eyeH), runTop, eyeX, eyeH);
      runBottom = cz;
      runRow = cy;
      runTop = solid && top > eyeH ? top : -1;
    }
    if (runTop > eyeH) pushBox(s, cx, Math.max(runBottom, eyeH), runTop, eyeX, eyeH);
  }
  pushReachWall(s, tops, ly * g.w, lx - SUN_REACH, eyeX, eyeH, g.w);
  pushReachWall(s, tops, ly * g.w, lx + SUN_REACH, eyeX, eyeH, g.w);
  return widestGap(s);
}

function pushReachWall(
  s: Scratch,
  tops: Float32Array,
  row: number,
  cx: number,
  eyeX: number,
  eyeH: number,
  w: number,
) {
  if (cx < 0 || cx >= w) return;
  const top = tops[row + cx]!;
  if (top <= eyeH) return;
  const east = cx > eyeX;
  const near = east ? cx : cx + 1;
  const angle = cornerAngle(near, top, eyeX, eyeH);
  push(s, east ? 0 : angle, east ? angle : Math.PI);
}

/**
 * Half the width, in arc units, of the fade at each end of a cell's span, so
 * a shadow edge slides in over a few clock minutes rather than snapping. The
 * shader in `worldQuads.ts` uses the same value.
 */
export const SUN_EDGE_ARC = 1.5 / SUN_SPAN_BYTE_MAX;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function sunVisibility(loByte: number, hiByte: number, arc: number): number {
  const lo = loByte / SUN_SPAN_BYTE_MAX;
  const hi = hiByte / SUN_SPAN_BYTE_MAX;
  return (
    smoothstep(lo - SUN_EDGE_ARC, lo + SUN_EDGE_ARC, arc) *
    (1 - smoothstep(hi - SUN_EDGE_ARC, hi + SUN_EDGE_ARC, arc))
  );
}
