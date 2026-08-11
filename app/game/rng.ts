/**
 * The world's dice.
 *
 * Deliberately not `Math.random()`. A brain that wanders has to be reproducible
 * to be debuggable: "the deer walked into the well" is a bug report nobody can
 * act on unless the same seed walks it into the same well. It is also the only
 * way to assert anything about wandering in a test without reaching for a mock.
 *
 * mulberry32 — a 32-bit state, one multiply-xor-shift round per draw. Chosen for
 * being small enough to read in one sitting and to checkpoint as a single
 * number; its statistical quality is far beyond what deciding which way a deer
 * turns could ever ask of it.
 */

/** Where a world starts rolling when nobody has said otherwise. */
export const DEFAULT_SEED = 0x9e3779b9;

export class Rng {
  private state: number;

  constructor(seed: number = DEFAULT_SEED) {
    // Coerced through a uint32 so a seed out of a checkpoint — or one somebody
    // typed — cannot put the generator in a state its arithmetic assumes away.
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /**
   * Fisher-Yates, in place, drawing from this generator.
   *
   * The one place a brain needs more than a single number: picking where to
   * wander is "try the legal directions in an unbiased order", not "pick one and
   * give up if it is blocked".
   */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  /**
   * The generator's whole state, for a checkpoint.
   *
   * The *current* state rather than the seed it started from: a world resumed
   * from its opening seed would replay the same wander it played before the
   * eviction, which is the one thing a fresh draw is supposed to avoid.
   */
  save(): number {
    return this.state;
  }
}
