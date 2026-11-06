import type { Direction } from "../../app/lib/types";

export type Vec = readonly [number, number, number];
export type Sdf = (p: Vec) => number;
export type Axes = { fw: Vec; lat: Vec; up: Vec };

/** `weight` lets a thin part (an ear, a feather) take a pixel it covers less than half of. */
export type Solid = { sdf: Sdf; ramp: readonly string[]; weight?: number };

export const FACING: Record<Direction, Vec> = {
  s: [0, 1, 0],
  e: [1, 0, 0],
  w: [-1, 0, 0],
  n: [0, -1, 0],
};

export function add(a: Vec, b: Vec): Vec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec, k: number): Vec {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function len(a: Vec): number {
  return Math.sqrt(dot(a, a));
}

export function normalise(a: Vec): Vec {
  return scale(a, 1 / len(a));
}

export function at(origin: Vec, ...terms: [Vec, number][]): Vec {
  return terms.reduce<Vec>((p, [axis, k]) => add(p, scale(axis, k)), origin);
}

export function axesFor(facing: Direction): Axes {
  const fw = FACING[facing];
  const up: Vec = [0, 0, 1];
  return { fw, lat: cross(up, fw), up };
}

function local(p: Vec, c: Vec, { fw, lat, up }: Axes): Vec {
  const q: Vec = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  return [dot(q, fw), dot(q, lat), dot(q, up)];
}

export function sphere(c: Vec, r: number): Sdf {
  return (p) => len([p[0] - c[0], p[1] - c[1], p[2] - c[2]]) - r;
}

/** Not an exact distance, but its sign and gradient are right, which is all the march and the shading read. */
export function ellipsoid(c: Vec, radii: Vec, axes: Axes): Sdf {
  const smallest = Math.min(...radii);
  return (p) => {
    const q = local(p, c, axes);
    return (len([q[0] / radii[0], q[1] / radii[1], q[2] / radii[2]]) - 1) * smallest;
  };
}

export function box(c: Vec, half: Vec, axes: Axes): Sdf {
  return (p) => {
    const q = local(p, c, axes);
    return Math.max(Math.abs(q[0]) - half[0], Math.abs(q[1]) - half[1], Math.abs(q[2]) - half[2]);
  };
}

export function cone(base: Vec, axis: Vec, height: number, radius: number): Sdf {
  const a = normalise(axis);
  return (p) => {
    const q: Vec = [p[0] - base[0], p[1] - base[1], p[2] - base[2]];
    const along = dot(q, a);
    const radial = len(add(q, scale(a, -along)));
    return Math.max(-along, along - height, radial - radius * (1 - along / height));
  };
}

export function cylinder(c: Vec, r: number, from: number, to: number): Sdf {
  return (p) => Math.max(Math.hypot(p[0] - c[0], p[1] - c[1]) - r, from - p[2], p[2] - to);
}

export function capsule(from: Vec, to: Vec, r: number): Sdf {
  const ab: Vec = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const abab = dot(ab, ab);
  return (p) => {
    const ap: Vec = [p[0] - from[0], p[1] - from[1], p[2] - from[2]];
    const k = Math.min(1, Math.max(0, dot(ap, ab) / abab));
    return len([ap[0] - ab[0] * k, ap[1] - ab[1] * k, ap[2] - ab[2] * k]) - r;
  };
}

export function above(sdf: Sdf, h: number): Sdf {
  return (p) => Math.max(sdf(p), h - p[2]);
}

export function below(sdf: Sdf, h: number): Sdf {
  return (p) => Math.max(sdf(p), p[2] - h);
}

export function minus(a: Sdf, b: Sdf): Sdf {
  return (p) => Math.max(a(p), -b(p));
}
