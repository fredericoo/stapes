import * as v from "valibot";
import { MAX_LIGHT_LEVEL } from "./lightingFlood";
import { clamp01, hexToRgb01, oklabToSrgb, srgbToOklab } from "./palette";
import {
  hexColorSchema,
  particleEmitterSchema,
  unitIntervalSchema,
  type ParticleEmitterDef,
} from "./particleVfx";
import type { LightDef } from "./types";

export type StatusTint = {
  color: string;
  strength: number;
  keepLuma: number;
};

export type StatusVfx = {
  tint: StatusTint | null;
  particles: ParticleEmitterDef | null;
  light: LightDef | null;
  taperMs: number;
};

export const MAX_TAPER_MS = 60_000;

export const TAPER_STEPS = 16;

export const NO_VFX: StatusVfx = {
  tint: null,
  particles: null,
  light: null,
  taperMs: 0,
};

export const DEFAULT_TINT: StatusTint = {
  color: "#a884f3",
  strength: 0.45,
  keepLuma: 1,
};

export const DEFAULT_GLOW: LightDef = {
  radius: 4,
  intensity: 0.6,
  color: "#fb6b1d",
};

const tintSchema = v.object({
  color: hexColorSchema,
  strength: unitIntervalSchema,
  keepLuma: v.optional(unitIntervalSchema, 1),
});

const glowSchema = v.object({
  radius: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_LIGHT_LEVEL)),
  intensity: unitIntervalSchema,
  color: hexColorSchema,
});

export const statusVfxSchema = v.object({
  tint: v.optional(v.nullable(tintSchema), null),
  particles: v.optional(v.nullable(particleEmitterSchema), null),
  light: v.optional(v.nullable(glowSchema), null),
  taperMs: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_TAPER_MS)), 0),
});

export type StatusVfxSource = v.InferOutput<typeof statusVfxSchema>;

export function resolveStatusVfx(raw: StatusVfxSource | undefined): StatusVfx {
  if (!raw) return NO_VFX;
  return {
    tint: raw.tint ? { ...raw.tint } : null,
    particles: raw.particles ? { ...raw.particles } : null,
    light: raw.light ? { ...raw.light } : null,
    taperMs: raw.taperMs,
  };
}

export function applyTint(
  rgb: readonly [number, number, number],
  tint: StatusTint,
): [number, number, number] {
  if (tint.strength <= 0) return [rgb[0], rgb[1], rgb[2]];
  const own = srgbToOklab(rgb[0], rgb[1], rgb[2]);
  const [tr, tg, tb] = hexToRgb01(tint.color);
  const target = srgbToOklab(tr, tg, tb);

  const mixed: [number, number, number] = [
    own[0] + (target[0] - own[0]) * tint.strength,
    own[1] + (target[1] - own[1]) * tint.strength,
    own[2] + (target[2] - own[2]) * tint.strength,
  ];
  mixed[0] = mixed[0] + (own[0] - mixed[0]) * tint.keepLuma;

  const out = oklabToSrgb(mixed[0], mixed[1], mixed[2]);
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])];
}

export function taperAt(remainingMs: number, taperMs: number): number {
  if (taperMs <= 0) return 1;
  const raw = remainingMs / taperMs;
  if (raw >= 1) return 1;
  if (raw <= 0) return 0;
  return Math.round(raw * TAPER_STEPS) / TAPER_STEPS;
}

export function taperedTint(tint: StatusTint, taper: number): StatusTint {
  if (taper >= 1) return tint;
  return { ...tint, strength: tint.strength * taper };
}

export function taperedGlow(light: LightDef, taper: number): LightDef {
  if (taper >= 1) return light;
  return { ...light, intensity: light.intensity * taper };
}
