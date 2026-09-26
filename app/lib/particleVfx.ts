import * as v from "valibot";
import { clamp01, hexToRgb01, oklabToSrgb, srgbToOklab } from "./palette";

export type RampStop = {
  at: number;
  color: string;
};

export type ParticleEmitterDef = {
  ratePerSecond: number;
  ttlFromMs: number;
  ttlToMs: number;
  spawnRadiusCells: number;
  spawnElevFrom: number;
  spawnElevTo: number;
  riseFrom: number;
  riseTo: number;
  driftCellsPerSecond: number;
  gravity: number;
  windX: number;
  windY: number;
  lit: boolean;
  shape: ParticleShape | null;
  radiusFromPx: number;
  radiusToPx: number;
  alphaFrom: number;
  alphaTo: number;
  ramp: RampStop[];
};

export const MAX_PARTICLE_TTL_MS = 10_000;

export const MAX_LIVE_PARTICLES = 2_048;

export const MAX_PARTICLE_RATE = 200;

export const MAX_PARTICLE_RADIUS_PX = 8;

export const PARTICLE_SHAPE_PX = 5;

export const SHAPE_PIXEL = "#";

export const SHAPE_EMPTY = ".";

export type ParticleShape = string[];

export const EMPTY_SHAPE: ParticleShape = Array.from({ length: PARTICLE_SHAPE_PX }, () =>
  SHAPE_EMPTY.repeat(PARTICLE_SHAPE_PX),
);

export function shapeHas(shape: ParticleShape, x: number, y: number): boolean {
  return shape[y]?.[x] === SHAPE_PIXEL;
}

export function toggleShapePixel(shape: ParticleShape, x: number, y: number): ParticleShape {
  return shape.map((row, rowY) =>
    rowY === y
      ? row.slice(0, x) + (row[x] === SHAPE_PIXEL ? SHAPE_EMPTY : SHAPE_PIXEL) + row.slice(x + 1)
      : row,
  );
}

export const MAX_RAMP_STOPS = 8;

export const RAMP_LUT_SIZE = 64;

export const DEFAULT_PARTICLES: ParticleEmitterDef = {
  ratePerSecond: 8,
  ttlFromMs: 700,
  ttlToMs: 1_400,
  spawnRadiusCells: 0.4,
  spawnElevFrom: 0,
  spawnElevTo: 0,
  riseFrom: 3,
  riseTo: 6,
  driftCellsPerSecond: 0.25,
  gravity: -1.6,
  windX: 0,
  windY: 0,
  lit: true,
  shape: null,
  radiusFromPx: 1,
  radiusToPx: 2,
  alphaFrom: 1,
  alphaTo: 0,
  ramp: [{ at: 0, color: "#1ebc73" }],
};

export const DEFAULT_IMPACT: ParticleEmitterDef = {
  ratePerSecond: 60,
  ttlFromMs: 90,
  ttlToMs: 180,
  spawnRadiusCells: 0.1,
  spawnElevFrom: 1,
  spawnElevTo: 3,
  riseFrom: 1,
  riseTo: 5,
  driftCellsPerSecond: 0.9,
  gravity: -18,
  windX: 0,
  windY: 0,
  lit: false,
  shape: null,
  radiusFromPx: 1,
  radiusToPx: 1,
  alphaFrom: 1,
  alphaTo: 0,
  ramp: [
    { at: 0, color: "#ffffff" },
    { at: 1, color: "#c7dcd0" },
  ],
};

export const hexColorSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/));

export const unitIntervalSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const particleTtlMs = v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_PARTICLE_TTL_MS));

const wind = v.pipe(v.number(), v.minValue(-32), v.maxValue(32));

const shapeSchema = v.pipe(
  v.array(
    v.pipe(
      v.string(),
      v.regex(new RegExp(`^[${SHAPE_PIXEL}${SHAPE_EMPTY}]{${PARTICLE_SHAPE_PX}}$`)),
    ),
  ),
  v.length(PARTICLE_SHAPE_PX),
);
const radiusPx = v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_PARTICLE_RADIUS_PX));

export const particleEmitterSchema = v.pipe(
  v.object({
    ratePerSecond: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_PARTICLE_RATE)),
    ttlFromMs: particleTtlMs,
    ttlToMs: particleTtlMs,
    spawnRadiusCells: v.pipe(v.number(), v.minValue(0), v.maxValue(4)),
    spawnElevFrom: v.pipe(v.number(), v.minValue(0), v.maxValue(32)),
    spawnElevTo: v.pipe(v.number(), v.minValue(0), v.maxValue(32)),
    riseFrom: v.pipe(v.number(), v.minValue(-32), v.maxValue(32)),
    riseTo: v.pipe(v.number(), v.minValue(-32), v.maxValue(32)),
    driftCellsPerSecond: v.pipe(v.number(), v.minValue(0), v.maxValue(8)),
    lit: v.optional(v.boolean(), false),
    gravity: v.pipe(v.number(), v.minValue(-32), v.maxValue(32)),
    windX: v.optional(wind, 0),
    windY: v.optional(wind, 0),
    shape: v.optional(v.nullable(shapeSchema), null),
    radiusFromPx: radiusPx,
    radiusToPx: radiusPx,
    alphaFrom: unitIntervalSchema,
    alphaTo: unitIntervalSchema,
    ramp: v.pipe(
      v.array(v.object({ at: unitIntervalSchema, color: hexColorSchema })),
      v.minLength(1),
      v.maxLength(MAX_RAMP_STOPS),
    ),
  }),
  v.check((raw) => raw.ttlToMs >= raw.ttlFromMs, "particle ttl range is inverted"),
  v.check(
    (raw) => raw.spawnElevTo >= raw.spawnElevFrom,
    "particle spawn elevation range is inverted",
  ),
  v.check((raw) => raw.riseTo >= raw.riseFrom, "particle rise range is inverted"),
);

export function compileRamp(stops: readonly RampStop[]): Float32Array {
  const lut = new Float32Array(RAMP_LUT_SIZE * 3);
  if (stops.length === 0) return lut;

  const sorted = [...stops].sort((a, b) => a.at - b.at);
  const lab = sorted.map((stop) => {
    const [r, g, b] = hexToRgb01(stop.color);
    return srgbToOklab(r, g, b);
  });

  for (let i = 0; i < RAMP_LUT_SIZE; i++) {
    const t = i / (RAMP_LUT_SIZE - 1);
    let next = 0;
    while (next < sorted.length && sorted[next]!.at < t) next++;

    let L: number;
    let a: number;
    let b: number;
    if (next === 0) {
      [L, a, b] = lab[0]!;
    } else if (next === sorted.length) {
      [L, a, b] = lab[lab.length - 1]!;
    } else {
      const lo = sorted[next - 1]!;
      const hi = sorted[next]!;
      const span = hi.at - lo.at;
      const k = span <= 0 ? 1 : (t - lo.at) / span;
      const loLab = lab[next - 1]!;
      const hiLab = lab[next]!;
      L = loLab[0] + (hiLab[0] - loLab[0]) * k;
      a = loLab[1] + (hiLab[1] - loLab[1]) * k;
      b = loLab[2] + (hiLab[2] - loLab[2]) * k;
    }

    const [sr, sg, sb] = oklabToSrgb(L, a, b);
    lut[i * 3] = clamp01(sr);
    lut[i * 3 + 1] = clamp01(sg);
    lut[i * 3 + 2] = clamp01(sb);
  }
  return lut;
}

export function rampIndexAt(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.min(RAMP_LUT_SIZE - 1, Math.round(clamped * (RAMP_LUT_SIZE - 1)));
}
