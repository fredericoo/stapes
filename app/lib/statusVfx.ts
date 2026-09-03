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

/**
 * What a status *looks* like: a colour worn by the body carrying it, a light it
 * casts, and a spray of particles over the tile it is standing on.
 *
 * ## Why this is not in `./status`
 *
 * A status's numbers are the simulation's business and are read on the server;
 * none of this is. A tint is a uniform and a particle is a circle drawn for
 * eight hundred milliseconds and then forgotten, and nothing on either side of
 * the wire ever needs to agree about where one of them got to. Keeping the
 * whole vocabulary in its own file is what lets that stay true: the session
 * imports `./status` and never reaches this, so an effect cannot accidentally
 * grow a consequence.
 *
 * ## Why the plume is not in *here*
 *
 * `./particleVfx` owns what an emitter is, because a status is no longer the
 * only thing that has one — a tile carries one too, and a chimney is not under
 * an effect. What is left here is the half that genuinely is about a status:
 * the tint, the cast light, and the wind-down that scales all three.
 */

/** A colour and how hard it is worn. @see StatusVfx.tint */
export type StatusTint = {
  /** `#rrggbb`. Quantised with the frame, so off-ramp values are requests. */
  color: string;
  /**
   * How far a sprite's own colour is dragged towards {@link color}, 0 to 1.
   *
   * Applied in OKLab rather than sRGB, which is what makes a middling value
   * read as a *wash* rather than as fog: an even step in OKLab is an even step
   * to the eye, so a poisoned body at 0.4 looks 40% poisoned across its whole
   * range instead of losing its darks first.
   */
  strength: number;
  /**
   * How much of the sprite's own lightness survives the wash, 0 to 1.
   *
   * At 1 this is a **palette swap**: hue and chroma move to the tint, lightness
   * is untouched, and every shading step the artist drew is still there — a
   * green rat and a purple rat, same rat. At 0 it is a wash that flattens
   * towards one colour, which is what a body about to stop being a body should
   * look like.
   *
   * Split from {@link strength} because they are different questions and get
   * different answers: "how poisoned" and "how much of the drawing is left".
   * One knob doing both meant the only way to get a strong purple was to lose
   * the sprite.
   */
  keepLuma: number;
};

export type StatusVfx = {
  /** Null for a status that does not colour the body carrying it. */
  tint: StatusTint | null;
  /** Null for a status that emits nothing. @see ParticleEmitterDef */
  particles: ParticleEmitterDef | null;
  /**
   * A light the bearer casts while this lasts, or null for one that is not lit.
   *
   * A {@link LightDef} and not a shape of this feature's own, because it *is*
   * one: it goes onto the same `EmitterOverride` a carried torch travels on, is
   * cast by the same bake, and accumulates with everything else at that cell.
   * A second vocabulary for "a light at a place" would be a second thing to keep
   * in step with the flood fill.
   *
   * The cost is the one a torch already pays and no more — see
   * `../render/GameRenderer`'s `emitterOverridesFor`. Statuses whose light does
   * not change are cache-stable; one that flickered would thrash the overlay
   * cache the way a flickering tile does, which is why there is no flicker here.
   */
  light: LightDef | null;
  /**
   * Milliseconds of remaining lifetime below which the whole effect winds down.
   *
   * **A count of what is left, not a fraction of what there was**, and that is
   * the point of it: a poison stacked to ten minutes and a poison that rolled ten
   * seconds should both fade over their final few seconds, not over their final
   * quarter. A fraction would give the stacked one a two-and-a-half-minute
   * sunset.
   *
   * Zero means never — full strength right up to the instant it ends, which is
   * how every status behaved before this existed and is still the default.
   *
   * Everything the status draws is scaled by it together: how many particles are
   * born, how big they are, how hard the tint is worn, and how bright the cast
   * light is. One scalar rather than four, because "this is nearly over" is one
   * fact and an effect whose halves faded at different rates would read as a bug.
   */
  taperMs: number;
};

/**
 * Longest a wind-down may run.
 *
 * A minute, which is far longer than a fade anybody wants to watch and short
 * enough that a typo'd extra digit reads as malformed rather than as a status
 * that spends its whole life fading.
 */
export const MAX_TAPER_MS = 60_000;

/**
 * Steps a taper is rounded to.
 *
 * **Not smoothing — a bound on two caches.** A tint is baked into a material
 * keyed by its strength (see `../render/spriteTint`), so a continuously varying
 * one would compile a fresh material every frame; a cast light rides a cache key
 * that has its intensity in it. Sixteen steps caps both at sixteen entries.
 *
 * Invisible at this size: a quarter-second step over a four-second fade, on a
 * ramp of twenty-nine colours that cannot render sixteen distinct washes anyway.
 */
export const TAPER_STEPS = 16;

/** A status with no effect authored on it — what every existing status has. */
export const NO_VFX: StatusVfx = {
  tint: null,
  particles: null,
  light: null,
  taperMs: 0,
};

/**
 * What the editor opens a fresh tint on: a wash strong enough to see, with the
 * shading fully intact. An author who wants a flatter one turns `keepLuma`
 * down, which is a more obvious move than discovering they needed it up.
 */
export const DEFAULT_TINT: StatusTint = {
  color: "#a884f3",
  strength: 0.45,
  keepLuma: 1,
};

/** What the editor opens a fresh glow on: a small, warm, steady light. */
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
  // Clamped rather than refused at the same ceiling a tile's light is clamped
  // to, and for the reason stated there: a light that stops short is a fixable
  // disappointment, and a world that refuses to load over a radius is not.
  radius: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_LIGHT_LEVEL)),
  intensity: unitIntervalSchema,
  color: hexColorSchema,
});

/**
 * The `vfx` block as it sits on disk.
 *
 * Every field optional and the whole block optional, because **every status
 * authored before this existed has to keep loading**. An absent block is
 * {@link NO_VFX}, which is exactly what those statuses already do.
 */
export const statusVfxSchema = v.object({
  tint: v.optional(v.nullable(tintSchema), null),
  particles: v.optional(v.nullable(particleEmitterSchema), null),
  light: v.optional(v.nullable(glowSchema), null),
  // Zero-defaulted, so every status authored before this existed keeps its full
  // strength to the last instant exactly as it always did.
  taperMs: v.optional(
    v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_TAPER_MS)),
    0,
  ),
});

export type StatusVfxSource = v.InferOutput<typeof statusVfxSchema>;

/** A validated block as the renderer wants it. Absent reads as no effect. */
export function resolveStatusVfx(raw: StatusVfxSource | undefined): StatusVfx {
  if (!raw) return NO_VFX;
  return {
    tint: raw.tint ? { ...raw.tint } : null,
    particles: raw.particles ? { ...raw.particles } : null,
    light: raw.light ? { ...raw.light } : null,
    taperMs: raw.taperMs,
  };
}

/** Whether anything here would put a pixel on screen. */
export function hasVfx(vfx: StatusVfx): boolean {
  return vfx.tint !== null || vfx.particles !== null || vfx.light !== null;
}

/**
 * One sprite colour under one tint — the reference the shader mirrors.
 *
 * The GLSL in `../render/spriteTint` is the thing that actually runs, and this is
 * what says what it should come to, on the terms `fragDepth` is the reference for
 * the depth GLSL. Stated in sRGB where the shader works in linear, which is the
 * same arithmetic: OKLab is defined on linear sRGB, so converting from either end
 * reaches the same lab triple.
 *
 * @param rgb sRGB 0..1.
 * @returns sRGB 0..1, clamped — a strong tint on a saturated sprite can land
 * outside the gamut, and a negative channel is not a colour.
 */
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

/**
 * How much of an effect is left, from what is left of the status.
 *
 * 1 until the status has {@link StatusVfx.taperMs} to run, then falling linearly
 * to 0 as it expires. Quantised — see {@link TAPER_STEPS}.
 */
export function taperAt(remainingMs: number, taperMs: number): number {
  if (taperMs <= 0) return 1;
  const raw = remainingMs / taperMs;
  if (raw >= 1) return 1;
  if (raw <= 0) return 0;
  return Math.round(raw * TAPER_STEPS) / TAPER_STEPS;
}

/** A tint worn as hard as the taper says it still is. */
export function taperedTint(
  tint: StatusTint,
  taper: number,
): StatusTint {
  if (taper >= 1) return tint;
  return { ...tint, strength: tint.strength * taper };
}

/** A cast light as bright as the taper says it still is. */
export function taperedGlow(light: LightDef, taper: number): LightDef {
  if (taper >= 1) return light;
  return { ...light, intensity: light.intensity * taper };
}
