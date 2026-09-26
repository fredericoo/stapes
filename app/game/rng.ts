export const DEFAULT_SEED = 0x9e3779b9;

export class Rng {
  private state: number;

  constructor(seed: number = DEFAULT_SEED) {
    this.state = seed >>> 0;
  }

  /**
   * mulberry32: one multiply-xor-shift round per draw, producing a uniform
   * float in [0, 1).
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  save(): number {
    return this.state;
  }
}
