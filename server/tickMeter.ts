export const TICK_PHASES = ["sim", "collect", "broadcast", "flush"] as const;

export type TickPhase = (typeof TICK_PHASES)[number];

export type Spread = { p50: number; p95: number; p99: number; max: number };

export type TickWindow = {
  ticks: number;
  skipped: number;
  failures: number;
  tick: Spread;
  late: Spread;
  phases: Record<TickPhase, Spread>;
};

function spreadOf(samples: number[]): Spread {
  if (!samples.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    hundredths(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!);
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: hundredths(sorted[sorted.length - 1]!),
  };
}

function hundredths(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function emptyPhases(): Record<TickPhase, number[]> {
  return { sim: [], collect: [], broadcast: [], flush: [] };
}

export class TickMeter {
  private ticks: number[] = [];
  private late: number[] = [];
  private phases = emptyPhases();
  private skipped = 0;
  private failures = 0;
  private lapAt: number | null = null;
  private beganAt = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  begin(lateMs: number) {
    this.late.push(Math.max(0, lateMs));
    this.beganAt = this.clock();
    this.lapAt = this.beganAt;
  }

  /** Does nothing outside `begin`…`end`, which is how a hand-stepped world ticks. */
  lap(phase: TickPhase) {
    if (this.lapAt === null) return;
    const now = this.clock();
    this.phases[phase].push(now - this.lapAt);
    this.lapAt = now;
  }

  end({ failed }: { failed: boolean }) {
    if (this.lapAt === null) return;
    this.ticks.push(this.clock() - this.beganAt);
    this.lapAt = null;
    if (failed) this.failures += 1;
  }

  skip(ticks: number) {
    this.skipped += ticks;
  }

  drain(): TickWindow | null {
    if (!this.ticks.length && !this.skipped) return null;
    const phases = {} as Record<TickPhase, Spread>;
    for (const phase of TICK_PHASES) phases[phase] = spreadOf(this.phases[phase]);
    const window: TickWindow = {
      ticks: this.ticks.length,
      skipped: this.skipped,
      failures: this.failures,
      tick: spreadOf(this.ticks),
      late: spreadOf(this.late),
      phases,
    };
    this.ticks = [];
    this.late = [];
    this.phases = emptyPhases();
    this.skipped = 0;
    this.failures = 0;
    return window;
  }
}
