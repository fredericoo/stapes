import * as v from "valibot";
import { clamp01, hexToRgb01, oklabToSrgb, srgbToOklab } from "./palette";

/**
 * What a plume *is*: how fast it is born, how it moves, and what colour it goes.
 *
 * ## Who emits one
 *
 * Two things, and they have nothing else in common. A **status** carries one
 * (`./statusVfx`), which is how a burning rat smokes. A **tile** carries one
 * (`./types`), which is how a chimney does — and a tile emitter is on the board
 * rather than on a body, so a torch dropped on the floor is lit for the same
 * reason the flame it fell out of is.
 *
 * That is the whole reason this is its own module. It was written inside
 * `./statusVfx`, whose premise is that the simulation never reads any of it
 * *because it belongs to a status*, and that premise stopped covering a plume
 * the moment a tile could ask for one.
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
 * is also what makes opacity legal — see {@link ParticleEmitterDef.alphaFrom}.
 */

/** One stop on a particle's colour ramp. @see ParticleEmitterDef.ramp */
export type RampStop = {
  /** Where in the particle's life this colour is reached, 0 to 1. */
  at: number;
  /** `#rrggbb`. */
  color: string;
};

/**
 * An emitter attached to a cell, in the units the world is measured in.
 *
 * **Everything spatial here is world units, never screen ones.** Cells across,
 * height units up. The projection turns "up" into up-and-left on screen, and an
 * author who typed a screen direction would have to re-derive it every time the
 * camera changed — so `rise` is elevation per second and the diagonal falls out
 * of the same projection every other sprite goes through.
 */
export type ParticleEmitterDef = {
  /** Particles born per second, across the whole emitter. */
  ratePerSecond: number;
  /** How long one particle lives. Drawn per particle, both ends included. */
  ttlFromMs: number;
  ttlToMs: number;
  /**
   * Half-width of the square a particle is born in, in cells about the cell's
   * centre. 0.5 is exactly the cell; larger spills over its neighbours.
   */
  spawnRadiusCells: number;
  /**
   * Height units above the emitter's foot a particle is born between.
   *
   * `0, 0` is the floor of the tile — where poison bubbles start. `0, 4` is the
   * whole body of a one-level tile, which is where a fire is. A chimney sets
   * both ends to its own height, so the smoke leaves the pot rather than the
   * bricks.
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

/**
 * What an editor opens a fresh emitter on: the poison plume, near enough.
 *
 * A default that draws *something* on the first frame, rather than a zeroed
 * block an author has to guess their way out of. Bubbles off the floor, rising,
 * spreading a little, fading as they go.
 */
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

/**
 * The two atoms every vfx block is made of.
 *
 * Exported from here rather than kept private because `./statusVfx` is built out
 * of the same two and already depends on this module for the emitter. Two
 * spellings of "is a hex colour" is how one of them ends up accepting `#fff`.
 */
export const hexColorSchema = v.pipe(
  v.string(),
  v.regex(/^#[0-9a-fA-F]{6}$/),
);

export const unitIntervalSchema = v.pipe(
  v.number(),
  v.minValue(0),
  v.maxValue(1),
);

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
    // Defaulted false, so every plume authored before this existed keeps
    // glowing in the dark exactly as it did — a silent change to how a fire
    // reads would be worse than an author having to tick a box.
    lit: v.optional(v.boolean(), false),
    gravity: v.pipe(v.number(), v.minValue(-32), v.maxValue(32)),
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

export type ParticleEmitterSource = v.InferOutput<typeof particleEmitterSchema>;

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

/** Index into a compiled ramp for a life fraction. */
export function rampIndexAt(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.min(RAMP_LUT_SIZE - 1, Math.round(clamped * (RAMP_LUT_SIZE - 1)));
}
