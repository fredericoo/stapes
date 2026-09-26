import * as v from "valibot";
import { hexColorSchema, particleEmitterSchema } from "./particleVfx";

export type TransitionSide = "appear" | "disappear";

export const TRANSITION_SIDES: readonly TransitionSide[] = ["appear", "disappear"];

export const MIN_TRANSITION_MS = 100;
export const MAX_TRANSITION_MS = 5_000;
export const MAX_SWEEP_ORIGIN_CELLS = 4;
export const MIN_CLUMP_PX = 1;
export const MAX_CLUMP_PX = 8;
export const DEFAULT_CLUMP_PX = 3;
export const MAX_EDGE_WIDTH = 0.5;
export const MAX_DROP_LEVELS = 4;
export const MAX_BURST_PARTICLES = 400;

const MS_PER_SECOND = 1000;

const sweepCoord = v.pipe(
  v.number(),
  v.minValue(-MAX_SWEEP_ORIGIN_CELLS),
  v.maxValue(MAX_SWEEP_ORIGIN_CELLS),
);

const dissolveSchema = v.pipe(
  v.object({
    pattern: v.picklist(["noise", "sweep", "dither"]),
    from: v.optional(v.object({ x: sweepCoord, y: sweepCoord })),
    clumpPx: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(MIN_CLUMP_PX), v.maxValue(MAX_CLUMP_PX)),
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
    durationMs: v.pipe(v.number(), v.minValue(MIN_TRANSITION_MS), v.maxValue(MAX_TRANSITION_MS)),
    dissolve: v.optional(dissolveSchema),
    scale: v.optional(v.object({})),
    drop: v.optional(
      v.object({
        levels: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DROP_LEVELS)),
      }),
    ),
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
      burstParticleCount(t.particles.ratePerSecond, t.durationMs) <= MAX_BURST_PARTICLES,
    "the burst spends more particles than one burst may",
  ),
);

export type Transition = v.InferOutput<typeof transitionSchema>;

export type TileTransitions = Partial<Record<TransitionSide, Transition>>;

const sidesSchema = v.looseObject({
  appear: v.optional(v.unknown()),
  disappear: v.optional(v.unknown()),
});

export type TileTransitionNote = {
  id: string;
  side: TransitionSide;
  tileId: string;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
  struckBy?: string;
};

export type HeldTransition = { note: TileTransitionNote; ageMs: number };

export const MAX_HELD_TRANSITIONS = 64;

export function burstParticleCount(ratePerSecond: number, durationMs: number): number {
  return (ratePerSecond * durationMs) / MS_PER_SECOND;
}

export function parseTileTransitions(raw: unknown): TileTransitions | undefined {
  const block = v.safeParse(sidesSchema, raw);
  if (!block.success) return undefined;
  const out: TileTransitions = {};
  for (const side of TRANSITION_SIDES) {
    const parsed = resolveTransition(block.output[side]);
    if (parsed) out[side] = parsed;
  }
  return out.appear || out.disappear ? out : undefined;
}

export function resolveTransition(raw: unknown): Transition | null {
  const parsed = v.safeParse(transitionSchema, raw);
  return parsed.success ? parsed.output : null;
}

export function transitionOf(
  def: { transitions?: TileTransitions } | undefined,
  side: TransitionSide,
): Transition | undefined {
  return def?.transitions?.[side];
}

export function shownFraction(side: TransitionSide, elapsedMs: number, durationMs: number): number {
  const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return side === "appear" ? progress : 1 - progress;
}
