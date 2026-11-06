import { PX_PER_HEIGHT, elevationScreenOffset } from "../../app/lib/geometry";
import { type Sdf, type Solid, type Vec, dot, normalise } from "./model";

const SUPERSAMPLE = 6;
const COVERAGE = 0.5;
const MARCH_STEP = 0.04;
const NORMAL_EPS = 0.05;
const AMBIENT = 0.2;
const DIFFUSE = 0.85;
const LIGHT = normalise([0.1, 0.45, 1]);

/** Height moves the screen by this much per pixel of height, so a ray runs along its opposite. */
const RISE = elevationScreenOffset(1 / PX_PER_HEIGHT);

/** The model point a screen position (sx, sy) sees at depth 0, and the direction towards the viewer that depth runs along. */
export type Camera = { at: (sx: number, sy: number) => Vec; toward: Vec };

export const WORLD_CAMERA: Camera = { at: (sx, sy) => [sx, sy, 0], toward: [-RISE.x, -RISE.y, 1] };

export type Bound = { centre: Vec; r: number };

/**
 * A grid of `width` × `height` pixels, each `px` model units wide, whose
 * top-left corner is at model screen position `origin`. A worn part is cast
 * at one model unit per pixel on the frame itself; an icon is cast coarser.
 */
export type Grid = { width: number; height: number; px: number; origin: readonly [number, number] };

export type Cell = { at: number; part: number; light: number };

type Hit = { solid: number; t: number };

/** Where the ray through (sx, sy) enters and leaves the bound, nearest the viewer first. */
function span(
  camera: Camera,
  { centre, r }: Bound,
  sx: number,
  sy: number,
): [number, number] | null {
  const d = camera.toward;
  const base = camera.at(sx, sy);
  const o: Vec = [base[0] - centre[0], base[1] - centre[1], base[2] - centre[2]];
  const a = dot(d, d);
  const b = 2 * dot(d, o);
  const disc = b * b - 4 * a * (dot(o, o) - r * r);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function point(camera: Camera, sx: number, sy: number, t: number): Vec {
  const base = camera.at(sx, sy);
  const d = camera.toward;
  return [base[0] + d[0] * t, base[1] + d[1] * t, base[2] + d[2] * t];
}

function march(camera: Camera, sdfs: Sdf[], bound: Bound, sx: number, sy: number): Hit | null {
  const s = span(camera, bound, sx, sy);
  if (!s) return null;
  for (let k = Math.floor(s[0] / MARCH_STEP); k * MARCH_STEP > s[1]; k--) {
    const t = k * MARCH_STEP;
    const p = point(camera, sx, sy, t);
    for (let i = 0; i < sdfs.length; i++) if (sdfs[i]!(p) < 0) return { solid: i, t };
  }
  return null;
}

function brightness(sdf: Sdf, p: Vec): number {
  const g: Vec = [
    sdf([p[0] + NORMAL_EPS, p[1], p[2]]) - sdf([p[0] - NORMAL_EPS, p[1], p[2]]),
    sdf([p[0], p[1] + NORMAL_EPS, p[2]]) - sdf([p[0], p[1] - NORMAL_EPS, p[2]]),
    sdf([p[0], p[1], p[2] + NORMAL_EPS]) - sdf([p[0], p[1], p[2] - NORMAL_EPS]),
  ];
  return Math.min(1, Math.max(0, AMBIENT + DIFFUSE * dot(normalise(g), LIGHT)));
}

/**
 * Casts `solids` with `occluders` in front of or behind them, and returns
 * the pixels the solids win: those they cover at least half of, or a thin
 * part covers enough of once its weight is counted. An occluder (the head
 * under a hat) blocks rays but is never drawn.
 */
export function cast(
  solids: Solid[],
  occluders: Sdf[],
  bound: Bound,
  grid: Grid,
  camera: Camera = WORLD_CAMERA,
): Cell[] {
  const sdfs = [...occluders, ...solids.map((s) => s.sdf)];
  const first = occluders.length;
  const cells: Cell[] = [];
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const counts = new Map<number, { n: number; light: number }>();
      let covered = 0;
      for (let j = 0; j < SUPERSAMPLE; j++) {
        for (let i = 0; i < SUPERSAMPLE; i++) {
          const sx = grid.origin[0] + (x + (i + 0.5) / SUPERSAMPLE) * grid.px;
          const sy = grid.origin[1] + (y + (j + 0.5) / SUPERSAMPLE) * grid.px;
          const hit = march(camera, sdfs, bound, sx, sy);
          if (!hit || hit.solid < first) continue;
          covered++;
          const part = hit.solid - first;
          const p = point(camera, sx, sy, hit.t);
          const entry = counts.get(part) ?? { n: 0, light: 0 };
          entry.n++;
          entry.light += brightness(sdfs[hit.solid]!, p);
          counts.set(part, entry);
        }
      }
      let best = -1;
      let bestScore = 0;
      for (const [part, { n }] of counts) {
        const score = (n / samples) * (solids[part]!.weight ?? 1);
        if (score > bestScore) [best, bestScore] = [part, score];
      }
      if (best < 0 || (covered / samples < COVERAGE && bestScore < COVERAGE)) continue;
      const won = counts.get(best)!;
      cells.push({ at: y * grid.width + x, part: best, light: won.light / won.n });
    }
  }
  return cells;
}

/** Ranking each ramp's pixels by their light, rather than thresholding it, means every part uses all of its ramp. */
export function shade(
  cells: { at: number; ramp: readonly string[]; light: number }[],
  size: number,
) {
  const out: (string | null)[] = Array.from({ length: size }, () => null);
  const byRamp = new Map<readonly string[], typeof cells>();
  for (const cell of cells) byRamp.set(cell.ramp, [...(byRamp.get(cell.ramp) ?? []), cell]);
  for (const [ramp, group] of byRamp) {
    group.sort((a, b) => a.light - b.light);
    group.forEach((cell, rank) => {
      const level = Math.min(
        ramp.length - 1,
        Math.floor(((rank + 0.5) / group.length) * ramp.length),
      );
      out[cell.at] = ramp[level]!;
    });
  }
  return out;
}

/** Outlines a part where it stands against `open` pixels: those with nothing under them but the body's own outline. */
export function outline(
  colours: (string | null)[],
  width: number,
  ink: string,
  open: (x: number, y: number) => boolean,
): (string | null)[] {
  const height = colours.length / width;
  const out = [...colours];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (colours[y * width + x]) continue;
      const beside = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => {
        const nx = x + dx!;
        const ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
        const c = colours[ny * width + nx];
        return c !== null && c !== ink;
      });
      if (beside && open(x, y)) out[y * width + x] = ink;
    }
  }
  return out;
}

/** Mirrors a square grid across its main diagonal, which in this projection swaps world x and y. */
export function transpose(colours: (string | null)[], size: number, ox = 0, oy = 0) {
  const out: (string | null)[] = Array.from({ length: size * size }, () => null);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colours[y * size + x];
      const nx = y + ox;
      const ny = x + oy;
      if (c && nx >= 0 && ny >= 0 && nx < size && ny < size) out[ny * size + nx] = c;
    }
  }
  return out;
}
