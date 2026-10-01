/**
 * What sets one bot apart from another. Bots that shared one set of numbers
 * made the same choice in the same frame, and a crowd of them moved as one.
 */
export type Temperament = {
  /** A creature rated above this share of the bot's rating is a threat. */
  readonly threatRatio: number;
  /** A threat this close is backed away from. */
  readonly waryCells: number;
  /** Below this share of its health the bot backs away from its foe. */
  readonly fleeHpShare: number;
  /** Below this share of its health the bot eats. */
  readonly eatHpShare: number;
  /** Prey further away than this is not worth setting off after. */
  readonly huntSightCells: number;
  /** A chase that has not closed in this long is given up. */
  readonly chaseGiveUpMs: number;
  /** Prey is picked at random among this many of the best. */
  readonly preyChoices: number;
  /** Time taken to act on a new decision. */
  readonly reactionMinMs: number;
  readonly reactionMaxMs: number;
  /** Time spent standing about after reaching a spot it explored. */
  readonly loiterMinMs: number;
  readonly loiterMaxMs: number;
};

export const DEFAULT_TEMPERAMENT: Temperament = {
  threatRatio: 1.25,
  waryCells: 7,
  fleeHpShare: 0.35,
  eatHpShare: 0.6,
  huntSightCells: 16,
  chaseGiveUpMs: 15_000,
  preyChoices: 3,
  reactionMinMs: 300,
  reactionMaxMs: 2_500,
  loiterMinMs: 5_000,
  loiterMaxMs: 30_000,
};

/** How far each number may stray from `DEFAULT_TEMPERAMENT`, as a share of it. */
export const TEMPERAMENT_SPREAD = 0.25;

/**
 * A temperament drawn around `DEFAULT_TEMPERAMENT`. The threat ratio strays
 * less than the rest, so every bot still keeps roughly to the 125% rule.
 */
export function drawTemperament(random: () => number): Temperament {
  const near = (value: number, spread = TEMPERAMENT_SPREAD) =>
    value * (1 + (random() * 2 - 1) * spread);
  const whole = (value: number) => Math.max(1, Math.round(near(value)));
  const d = DEFAULT_TEMPERAMENT;
  const reactionMinMs = near(d.reactionMinMs);
  const loiterMinMs = near(d.loiterMinMs);
  return {
    threatRatio: near(d.threatRatio, 0.08),
    waryCells: whole(d.waryCells),
    fleeHpShare: near(d.fleeHpShare),
    eatHpShare: near(d.eatHpShare),
    huntSightCells: whole(d.huntSightCells),
    chaseGiveUpMs: near(d.chaseGiveUpMs),
    preyChoices: whole(d.preyChoices),
    reactionMinMs,
    reactionMaxMs: Math.max(reactionMinMs, near(d.reactionMaxMs)),
    loiterMinMs,
    loiterMaxMs: Math.max(loiterMinMs, near(d.loiterMaxMs)),
  };
}

/**
 * A random sequence seeded from a string (mulberry32 over an FNV-1a hash), so
 * a bot keeps its temperament across restarts while two bots differ.
 */
export function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function between(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}
