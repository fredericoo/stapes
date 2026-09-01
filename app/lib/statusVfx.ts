import * as v from "valibot";
import { MAX_LIGHT_LEVEL } from "./lightingFlood";
import { hexToRgb01, oklabToSrgb, srgbToOklab } from "./palette";
import type { LightDef } from "./types";

/**
 * What a status *looks* like: a colour worn by the body carrying it, and a
 * spray of particles over the tile it is standing on.
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
 * ## Client-side, and deliberately amnesiac
 *
 * Particles are simulated from whatever the frame clock says has elapsed, in the
 * renderer that is drawing them, and nowhere else. Walking off the edge of the
 * screen and back does not resume an animation half-way — it starts a new one —
 * and that is the whole reason this can cost what it costs. A faithful one would
 * have to be either broadcast or seeded and replayed, and both of those are a
 * price paid every tick for something nobody can see.
 *
 * ## Colours are hex, and the ramp is what fixes them
 *
 * Authored as free hex rather than picked off `./palette`, because the useful
 * stops in a burn — the moment between yellow and red — are not on the ramp and
 * an author who can only name ramp entries cannot ask for the colour *between*
 * two of them. What reaches the screen is quantised anyway: everything here is
 * drawn into the scene target and goes through `../render/palettePass` with the
 * rest of the frame, so an off-ramp hex is a request rather than a promise. That
 * is also what makes opacity legal — see {@link StatusParticles.alphaFrom}.
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

/** One stop on a particle's colour ramp. @see StatusParticles.ramp */
export type RampStop = {
  /** Where in the particle's life this colour is reached, 0 to 1. */
  at: number;
  /** `#rrggbb`. */
  color: string;
};

/**
 * An emitter attached to a tile, in the units the world is measured in.
 *
 * **Everything spatial here is world units, never screen ones.** Cells across,
 * height units up. The projection turns "up" into up-and-left on screen, and an
 * author who typed a screen direction would have to re-derive it every time the
 * camera changed — so `rise` is elevation per second and the diagonal falls out
 * of the same projection every other sprite goes through.
 */
export type StatusParticles = {
  /** Particles born per second, across the whole emitter. */
  ratePerSecond: number;
  /** How long one particle lives. Drawn per particle, both ends included. */
  ttlFromMs: number;
  ttlToMs: number;
  /**
   * Half-width of the square a particle is born in, in cells about the tile's
   * centre. 0.5 is exactly the cell; larger spills over its neighbours.
   */
  spawnRadiusCells: number;
  /**
   * Height units above the tile's foot a particle is born between.
   *
   * `0, 0` is the floor of the tile — where poison bubbles start. `0, 4` is the
   * whole body of a one-level tile, which is where a fire is.
   */
  spawnElevFrom: number;
  spawnElevTo: number;
  /** Height units per second, drawn per particle. Positive rises. */
  riseFrom: number;
  riseTo: number;
  /**
   * Cells per second of sideways wander, drawn per particle per axis.
   *
   * The "some randomisation" half of a plume. Drawn once at birth rather than
   * re-drawn per frame: a particle that picked a new direction every frame is
   * noise, and one that picks a direction and keeps it is a bubble.
   */
  driftCellsPerSecond: number;
  /**
   * Height units per second squared, applied to the rise. Negative pulls back
   * down — the fallout on a plume that runs out of push.
   */
  gravity: number;
  /**
   * Whether the room's light reaches these particles.
   *
   * **Off by default, because a spark is usually its own light source.** A fire
   * is bright *because* it is a fire, and dimming its embers with the light of
   * the cellar they are in gets it exactly backwards.
   *
   * On for anything that is merely matter: a bubble of gas coming off a poisoned
   * body is lit like the body is, and one that stayed visible in pitch black
   * would be a poisoned enemy you could track through an unlit room.
   *
   * Costs a per-particle light sample and puts the plume in its level's draw
   * group — see `../render/particleLayer`.
   */
  lit: boolean;
  /** Circle radius in world pixels, at birth and at death. */
  radiusFromPx: number;
  radiusToPx: number;
  /**
   * Opacity at birth and at death.
   *
   * Real alpha, and legal precisely because of *where* it is blended: particles
   * go into the scene target with the world, so a half-faded particle is
   * composited and then quantised, and what lands on the canvas is a solid
   * palette entry. Fading after the quantise — which is what the editor's level
   * fade does — would put colours on screen that are not in the palette.
   */
  alphaFrom: number;
  alphaTo: number;
  /**
   * The colour over a particle's life, as stops. At least one.
   *
   * Sampled by age rather than by height or speed, so a ramp reads the same
   * whatever the plume is doing. One stop is a constant colour — the poison
   * case. Four is a fire: white, yellow, red, ash.
   *
   * A random per-particle colour is what a ramp plus a random {@link ttlFromMs}
   * already produces: two particles born together with different lifetimes are
   * at different points of the ramp for every frame they share, so a fire is
   * every colour at once without anything here having to draw one.
   */
  ramp: RampStop[];
};

export type StatusVfx = {
  /** Null for a status that does not colour the body carrying it. */
  tint: StatusTint | null;
  /** Null for a status that emits nothing. */
  particles: StatusParticles | null;
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
 * Longest a particle may live.
 *
 * A sanity bound on the terms `MAX_STATUS_DURATION_MS` is: ten seconds is
 * longer than any spark worth drawing, and it is what stops a typo'd extra
 * digit from filling {@link MAX_LIVE_PARTICLES} with one emitter's backlog and
 * starving every other effect on screen.
 */
export const MAX_PARTICLE_TTL_MS = 10_000;

/**
 * Most particles alive at once, across every emitter on screen.
 *
 * The pool is allocated to this at startup and never grows — see
 * `../render/particles`. Sized from the worst case worth supporting rather than
 * the common one: a dozen burning bodies in view at the burn preset's rate.
 */
export const MAX_LIVE_PARTICLES = 2_048;

/** Most particles one emitter may ask for per second. */
export const MAX_PARTICLE_RATE = 200;

/** Widest a particle may be drawn, in world pixels. @see circleAtlas */
export const MAX_PARTICLE_RADIUS_PX = 8;

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

/** Most stops one ramp may carry. Beyond this it is a gradient, not pixel art. */
export const MAX_RAMP_STOPS = 8;

/**
 * Samples in a compiled ramp.
 *
 * The ramp is flattened to a lookup table once per emitter and read by index
 * per particle per frame, because the honest thing — interpolating in OKLab at
 * the point of use — is six transcendentals per particle per frame and this is
 * three array reads. 64 is far more resolution than survives the quantise: the
 * palette is 29 colours, so a table this size cannot be the thing that loses a
 * step.
 */
export const RAMP_LUT_SIZE = 64;

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

/**
 * What the editor opens a fresh emitter on: the poison plume, near enough.
 *
 * A default that draws *something* on the first frame, rather than a zeroed
 * block an author has to guess their way out of. Bubbles off the floor, rising,
 * spreading a little, fading as they go.
 */
export const DEFAULT_PARTICLES: StatusParticles = {
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
  // Lit by default on the *editor's* fresh emitter, unlike the type's own
  // resting state: a new plume is far more often smoke or gas than fire, and an
  // author who wants embers turns it off having seen what the difference is.
  lit: true,
  radiusFromPx: 1,
  radiusToPx: 2,
  alphaFrom: 1,
  alphaTo: 0,
  ramp: [{ at: 0, color: "#1ebc73" }],
};

/** What the editor opens a fresh glow on: a small, warm, steady light. */
export const DEFAULT_GLOW: LightDef = {
  radius: 4,
  intensity: 0.6,
  color: "#fb6b1d",
};

const HEX_COLOR = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/));

const unitInterval = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const tintSchema = v.object({
  color: HEX_COLOR,
  strength: unitInterval,
  keepLuma: v.optional(unitInterval, 1),
});

const particleTtlMs = v.pipe(
  v.number(),
  v.minValue(0),
  v.maxValue(MAX_PARTICLE_TTL_MS),
);

const radiusPx = v.pipe(
  v.number(),
  v.minValue(0),
  v.maxValue(MAX_PARTICLE_RADIUS_PX),
);

const particlesSchema = v.pipe(
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
    // Defaulted false, so every plume authored before this existed keeps
    // glowing in the dark exactly as it did — a silent change to how a fire
    // reads would be worse than an author having to tick a box.
    lit: v.optional(v.boolean(), false),
    gravity: v.pipe(v.number(), v.minValue(-32), v.maxValue(32)),
    radiusFromPx: radiusPx,
    radiusToPx: radiusPx,
    alphaFrom: unitInterval,
    alphaTo: unitInterval,
    ramp: v.pipe(
      v.array(v.object({ at: unitInterval, color: HEX_COLOR })),
      v.minLength(1),
      v.maxLength(MAX_RAMP_STOPS),
    ),
  }),
  // Inverted ranges read as malformed, exactly as an inverted status duration
  // does — and for the same reason: the editor keeps both pairs ordered, so
  // nothing authored through it can land here, and anything that does was
  // written by hand and is a mistake rather than a shorthand.
  v.check((raw) => raw.ttlToMs >= raw.ttlFromMs, "particle ttl range is inverted"),
  v.check(
    (raw) => raw.spawnElevTo >= raw.spawnElevFrom,
    "particle spawn elevation range is inverted",
  ),
  v.check((raw) => raw.riseTo >= raw.riseFrom, "particle rise range is inverted"),
);

/**
 * The `vfx` block as it sits on disk.
 *
 * Every field optional and the whole block optional, because **every status
 * authored before this existed has to keep loading**. An absent block is
 * {@link NO_VFX}, which is exactly what those statuses already do.
 */
const glowSchema = v.object({
  // Clamped rather than refused at the same ceiling a tile's light is clamped
  // to, and for the reason stated there: a light that stops short is a fixable
  // disappointment, and a world that refuses to load over a radius is not.
  radius: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_LIGHT_LEVEL)),
  intensity: unitInterval,
  color: HEX_COLOR,
});

export const statusVfxSchema = v.object({
  tint: v.optional(v.nullable(tintSchema), null),
  particles: v.optional(v.nullable(particlesSchema), null),
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
 * A ramp flattened to {@link RAMP_LUT_SIZE} sRGB triples, interpolated in OKLab.
 *
 * OKLab and not sRGB because the midpoints are the whole point of a ramp: the
 * halfway house between `#ffffff` and `#fbb954` is a warm cream in OKLab and a
 * washed-out grey-yellow in sRGB, and a fire made of the second one looks like
 * a fire behind a dirty window.
 *
 * Stops are sorted here rather than trusted, so an author who inserts a stop
 * and drags it past its neighbour gets the ramp they can see rather than a
 * ramp that runs backwards over one segment. Anything before the first stop or
 * after the last holds that stop's colour — a ramp is not obliged to start at 0
 * or end at 1.
 */
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
      // Two stops at one position is a hard edge rather than a division by
      // zero: the later one wins from that point on, which is what an author
      // stacking two stops is asking for.
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

/** Index into a compiled ramp for a life fraction. */
export function rampIndexAt(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.min(RAMP_LUT_SIZE - 1, Math.round(clamped * (RAMP_LUT_SIZE - 1)));
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
