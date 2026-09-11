import * as v from "valibot";
import { hexColorSchema, particleEmitterSchema } from "./particleVfx";

/**
 * How a tile arrives on the board and how it leaves it: authored per tile, and
 * drawn by the renderer alone.
 *
 * **Opt-in, and only for causes the server can name.** A tile with nothing
 * authored changes the instant the map says so, which is what blood, berries
 * and bushes have always done. A tile with a side authored gets it played when
 * the server says *why* it changed — something new on the board for `appear`
 * (a conjure, `/tile`, a respawn, a player arriving, what a decay turned
 * into), a decay, a death or a player leaving for `disappear` — because a
 * cell patch alone cannot tell a flame that burned out from a berry that was
 * picked up.
 *
 * The simulation never reads this, on the terms `particles` is never read: what
 * a transition looks like is not on the tick, and cannot hurt anybody.
 */

export type TransitionSide = "appear" | "disappear";

export const TRANSITION_SIDES: readonly TransitionSide[] = ["appear", "disappear"];

export const MIN_TRANSITION_MS = 100;
export const MAX_TRANSITION_MS = 5_000;
/** How far a sweep may start from the tile, in cells, on either axis. */
export const MAX_SWEEP_ORIGIN_CELLS = 4;
export const MIN_CLUMP_PX = 1;
export const MAX_CLUMP_PX = 8;
export const DEFAULT_CLUMP_PX = 3;
/** The glowing band at the dissolve front, as a share of the whole threshold. */
export const MAX_EDGE_WIDTH = 0.5;
export const MAX_DROP_LEVELS = 4;
/**
 * The most particles one burst may spend over its whole duration.
 *
 * The pool is shared and served in emitter order, so a burst is starved first —
 * but a single burst wide enough to fill most of the pool on its own would
 * still thin every fire on screen for as long as it ran.
 */
export const MAX_BURST_PARTICLES = 400;

const MS_PER_SECOND = 1000;

const sweepCoord = v.pipe(
  v.number(),
  v.minValue(-MAX_SWEEP_ORIGIN_CELLS),
  v.maxValue(MAX_SWEEP_ORIGIN_CELLS),
);

const dissolveSchema = v.pipe(
  v.object({
    /**
     * `dither` is a dissolve and not an opacity: a 4×4 ordered pattern is the
     * same discard-above-threshold path as noise, with a different threshold.
     * There is no alpha — world tiles write their own per-pixel depth, and a
     * half-transparent pixel would also land off the palette.
     */
    pattern: v.picklist(["noise", "sweep", "dither"]),
    /**
     * Where a sweep's front starts, in cells from the tile, **on either side**.
     * Deliberately not mirrored for `appear`, so "forms in from (-1,-1)" means
     * the front starts at (-1,-1) — the one field that is not a hidden end.
     */
    from: v.optional(v.object({ x: sweepCoord, y: sweepCoord })),
    clumpPx: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(MIN_CLUMP_PX),
        v.maxValue(MAX_CLUMP_PX),
      ),
      DEFAULT_CLUMP_PX,
    ),
    edgeColor: hexColorSchema,
    edgeWidth: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_EDGE_WIDTH)),
  }),
  v.check(
    (dissolve) => dissolve.pattern !== "sweep" || dissolve.from !== undefined,
    "a sweep needs somewhere to start",
  ),
);

const transitionSchema = v.pipe(
  v.object({
    durationMs: v.pipe(
      v.number(),
      v.minValue(MIN_TRANSITION_MS),
      v.maxValue(MAX_TRANSITION_MS),
    ),
    dissolve: v.optional(dissolveSchema),
    /**
     * To nothing, towards the middle of the cell the tile stands on, and on the
     * pixel grid throughout. Present-or-absent is the whole setting.
     */
    scale: v.optional(v.object({})),
    /**
     * The hidden end is `levels` storeys up. A drop and not an x/y offset: one
     * level up lands on the same pixel as one cell up-left in this projection,
     * but only the level sorts as something *above its own cell*.
     */
    drop: v.optional(
      v.object({
        levels: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(MAX_DROP_LEVELS),
        ),
      }),
    ),
    /** A burst for the length of the transition, from the tile's cell. */
    particles: v.optional(particleEmitterSchema),
  }),
  v.check(
    (t) =>
      t.dissolve !== undefined ||
      t.scale !== undefined ||
      t.drop !== undefined ||
      t.particles !== undefined,
    "a transition has to do something",
  ),
  v.check(
    (t) =>
      !t.particles ||
      burstParticleCount(t.particles.ratePerSecond, t.durationMs) <=
        MAX_BURST_PARTICLES,
    "the burst spends more particles than one burst may",
  ),
);

/**
 * One side of a tile's transitions.
 *
 * A record of optional effects rather than a list of steps: they all run
 * together over `durationMs`, so an order would mean nothing and cost a
 * uniqueness rule and a reorderable editor. Each describes the tile's *hidden*
 * end, and `appear` plays it backwards — see {@link shownFraction}.
 */
export type Transition = v.InferOutput<typeof transitionSchema>;

export type TileTransitions = Partial<Record<TransitionSide, Transition>>;

/** The block's outline only, so each side can be parsed, and dropped, on its own. */
const sidesSchema = v.looseObject({
  appear: v.optional(v.unknown()),
  disappear: v.optional(v.unknown()),
});

/**
 * A tile that changed for a reason the renderer can play, as the server says it.
 *
 * `stackIndex` is the placement's slot at the moment it happened — in the stack
 * it left, for a disappear, and in the stack it joined, for an appear — so two
 * copies of one tile in one cell are two transitions and never one.
 *
 * **The slot is a hint, not an address.** The rest of the tick can still move
 * things in that cell before anybody is told — gravity settling a conjured
 * tile, a creature eating what was under it — so whoever plays a note checks
 * the tile is still where it says. See `../render/tileTransitions`'s
 * `resolveTransitionSlot`.
 */
export type TileTransitionNote = {
  id: string;
  side: TransitionSide;
  tileId: string;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
};

/**
 * A note as a viewer takes it, with how long ago it was heard, so a renderer
 * that could not take it at once starts it that far in rather than from the top.
 */
export type HeldTransition = { note: TileTransitionNote; ageMs: number };

/**
 * The most notes held for a viewer that has not taken them yet.
 *
 * A cap and not only an expiry, because nothing ages while a tab is hidden and
 * the notes keep arriving: a player who comes back to a background tab gets the
 * newest few and never an hour's backlog. The oldest go first.
 */
export const MAX_HELD_TRANSITIONS = 64;

/**
 * How many particles a burst spends over a transition. The one reckoning both
 * the schema's cap and the editor's warning use, so they cannot disagree.
 */
export function burstParticleCount(
  ratePerSecond: number,
  durationMs: number,
): number {
  return (ratePerSecond * durationMs) / MS_PER_SECOND;
}

/**
 * An authored block, held to what the renderer can play.
 *
 * Each side is parsed on its own and **dropped rather than refused** when it
 * does not parse, on exactly the terms a malformed plume is: one author's own
 * content, and a world that would not load over a dissolve is worse than a
 * flame that simply appears. Undefined when neither side survives.
 */
export function parseTileTransitions(raw: unknown): TileTransitions | undefined {
  const block = v.safeParse(sidesSchema, raw);
  if (!block.success) return undefined;
  const out: TileTransitions = {};
  for (const side of TRANSITION_SIDES) {
    const parsed = v.safeParse(transitionSchema, block.output[side]);
    if (parsed.success) out[side] = parsed.output;
  }
  return out.appear || out.disappear ? out : undefined;
}

/** The side a tile has authored, or undefined — the whole of what "opt-in" is. */
export function transitionOf(
  def: { transitions?: TileTransitions } | undefined,
  side: TransitionSide,
): Transition | undefined {
  return def?.transitions?.[side];
}

/**
 * How much of the tile is showing, `elapsedMs` into a transition.
 *
 * 0 is the hidden end every effect describes and 1 is the tile as it sits on
 * the board. An appear climbs from 0 and a disappear falls from 1, which is the
 * whole of "appear plays it backwards": every effect reads this one number.
 */
export function shownFraction(
  side: TransitionSide,
  elapsedMs: number,
  durationMs: number,
): number {
  const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return side === "appear" ? progress : 1 - progress;
}
