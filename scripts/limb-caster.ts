export type Vec3 = [number, number, number];

/** A tapered capsule: a limb, a pad, a stem, anything round along a line. */
export type Capsule = { from: Vec3; to: Vec3; radiusFrom: number; radiusTo: number };

export type Hit<L extends Capsule> = { normal: Vec3; limb: L };

/**
 * Where the standing cell sits in the sprite and how high the ray starts. A
 * point is given in pixels of its own cell, `z` up, so `groundPx` is the
 * sprite pixel the cell's north-west corner is drawn at.
 */
export type Projection = { spritePx: number; groundPx: number; topPx: number };

const SUPERSAMPLE = 3;
const MARCH_STEP_PX = 1 / 32;

/** A limb thinner than a pixel still draws when a quarter of the pixel's samples meet it. */
const COVERAGE_SHARE = 1 / 4;

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function normalise(a: Vec3): Vec3 {
  return scale(a, 1 / Math.hypot(...a));
}

type Bounded<L extends Capsule> = { limb: L; low: number; high: number };

/** How far `p` is inside the tapered capsule round a limb; positive is inside. */
function insideLimb(limb: Capsule, p: Vec3): { depth: number; axis: Vec3 } {
  const d: Vec3 = [limb.to[0] - limb.from[0], limb.to[1] - limb.from[1], limb.to[2] - limb.from[2]];
  const rel: Vec3 = [p[0] - limb.from[0], p[1] - limb.from[1], p[2] - limb.from[2]];
  const lengthSq = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const t = Math.max(0, Math.min(1, (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / lengthSq));
  const axis = add(limb.from, scale(d, t));
  const radius = limb.radiusFrom + (limb.radiusTo - limb.radiusFrom) * t;
  const off = Math.hypot(p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]);
  return { depth: radius - off, axis };
}

function bounded<L extends Capsule>(limb: L): Bounded<L> {
  const reach = Math.max(limb.radiusFrom, limb.radiusTo);
  return {
    limb,
    low: Math.min(limb.from[2], limb.to[2]) - reach,
    high: Math.max(limb.from[2], limb.to[2]) + reach,
  };
}

/**
 * Walks the view ray down from `topPx`. A point at height `z` is drawn `z`
 * pixels up and to the left of where it stands, so the ray through sprite
 * pixel `u, v` meets `u - groundPx + z, v - groundPx + z` at that height.
 */
function castRay<L extends Capsule>(
  limbs: readonly Bounded<L>[],
  projection: Projection,
  u: number,
  v: number,
): Hit<L> | null {
  const { groundPx, topPx } = projection;
  for (let z = topPx; z > 0; z -= MARCH_STEP_PX) {
    const p: Vec3 = [u - groundPx + z, v - groundPx + z, z];
    for (const { limb, low, high } of limbs) {
      if (z < low || z > high) continue;
      const { depth, axis } = insideLimb(limb, p);
      if (depth >= 0)
        return { limb, normal: normalise([p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]]) };
    }
  }
  return null;
}

function samplePixel<L extends Capsule>(
  limbs: readonly Bounded<L>[],
  projection: Projection,
  shade: (hit: Hit<L>) => number,
  u: number,
  v: number,
): number | null {
  const votes = new Map<number, number>();
  let hits = 0;
  for (let j = 0; j < SUPERSAMPLE; j++) {
    for (let i = 0; i < SUPERSAMPLE; i++) {
      const hit = castRay(
        limbs,
        projection,
        u + (i + 0.5) / SUPERSAMPLE,
        v + (j + 0.5) / SUPERSAMPLE,
      );
      if (!hit) continue;
      hits++;
      const index = shade(hit);
      votes.set(index, (votes.get(index) ?? 0) + 1);
    }
  }
  if (hits < SUPERSAMPLE * SUPERSAMPLE * COVERAGE_SHARE) return null;
  return [...votes].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Casts every pixel of a square sprite through the game's projection and
 * hands each one a limb covers to `paintAt`, with the palette index `shade`
 * chose for it. An earlier limb in the list wins where two meet at one height.
 */
export function castSprite<L extends Capsule>(
  limbs: readonly L[],
  projection: Projection,
  shade: (hit: Hit<L>) => number,
  paintAt: (u: number, v: number, index: number) => void,
) {
  const boxes = limbs.map(bounded);
  for (let v = 0; v < projection.spritePx; v++) {
    for (let u = 0; u < projection.spritePx; u++) {
      const index = samplePixel(boxes, projection, shade, u, v);
      if (index !== null) paintAt(u, v, index);
    }
  }
}
