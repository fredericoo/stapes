/**
 * Per-phase frame timing.
 *
 * Reports the worst frame in each window alongside the median, because the two
 * answer different questions. A stutter every 200ms barely moves an average —
 * it is the spike that is felt, and a mean would hide exactly the thing you
 * opened the counter to find.
 */

/** Ordered so the readout reads in the order work actually happens. */
export const FRAME_PHASES = [
  "sim",
  "view",
  "sync",
  "map",
  "light",
  "motion",
  "anim",
  "draw",
] as const;

export type FramePhase = (typeof FRAME_PHASES)[number];

export type PhaseTiming = { p50: number; worst: number };

export type FrameStats = {
  fps: number;
  frame: PhaseTiming;
  phases: Record<FramePhase, PhaseTiming>;
};

/** Milliseconds between reports. Long enough to catch a step, short enough to feel live. */
const REPORT_INTERVAL_MS = 500;

function summarise(samples: number[]): PhaseTiming {
  if (!samples.length) return { p50: 0, worst: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[sorted.length >> 1]!,
    worst: sorted[sorted.length - 1]!,
  };
}

export class FrameProfiler {
  private frames: number[] = [];
  private phases = new Map<FramePhase, number[]>();
  private lastReport = 0;

  /** Time `fn`, record it against `phase`, and hand back whatever it returned. */
  measure<T>(phase: FramePhase, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.record(phase, performance.now() - start);
    }
  }

  record(phase: FramePhase, ms: number) {
    let bucket = this.phases.get(phase);
    if (!bucket) {
      bucket = [];
      this.phases.set(phase, bucket);
    }
    bucket.push(ms);
  }

  frame(ms: number) {
    this.frames.push(ms);
  }

  /** Stats once per {@link REPORT_INTERVAL_MS}, else null. Resets on report. */
  report(now: number): FrameStats | null {
    if (!this.lastReport) {
      this.lastReport = now;
      return null;
    }
    const elapsed = now - this.lastReport;
    if (elapsed < REPORT_INTERVAL_MS || !this.frames.length) return null;

    const phases = {} as Record<FramePhase, PhaseTiming>;
    for (const name of FRAME_PHASES) {
      phases[name] = summarise(this.phases.get(name) ?? []);
    }
    const stats: FrameStats = {
      fps: Math.round((this.frames.length * 1000) / elapsed),
      frame: summarise(this.frames),
      phases,
    };

    this.frames = [];
    this.phases.clear();
    this.lastReport = now;
    return stats;
  }
}
