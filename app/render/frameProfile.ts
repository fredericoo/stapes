export const FRAME_PHASES = [
  "sim",
  "view",
  "sync",
  "map",
  "light",
  "state",
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
