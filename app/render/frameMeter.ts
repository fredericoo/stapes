import { FRAME_BUCKETS, FRAME_GAP_MS, frameBucket, type FrameSpan } from "../net/frameReport";
import { FRAME_PHASES, type FramePhase, type FrameStats } from "./frameProfile";

/**
 * Counts the time between one animation frame and the next, which includes
 * what the browser and the GPU did, where `FrameProfiler` times only the
 * script inside a frame.
 */
export class FrameMeter {
  private buckets = new Array<number>(FRAME_BUCKETS).fill(0);
  private frames = 0;
  private worstMs = 0;
  private gaps = 0;
  private spanMs = 0;
  private phaseSums = new Map<FramePhase, number>();
  private phaseWorst = new Map<FramePhase, number>();
  private phaseReports = 0;

  frame(intervalMs: number) {
    if (intervalMs >= FRAME_GAP_MS) {
      this.gaps += 1;
      return;
    }
    this.frames += 1;
    this.spanMs += intervalMs;
    this.buckets[frameBucket(intervalMs)]! += 1;
    if (intervalMs > this.worstMs) this.worstMs = intervalMs;
  }

  phases(stats: FrameStats) {
    this.phaseReports += 1;
    for (const phase of FRAME_PHASES) {
      const { p50, worst } = stats.phases[phase];
      this.phaseSums.set(phase, (this.phaseSums.get(phase) ?? 0) + p50);
      if (worst > (this.phaseWorst.get(phase) ?? 0)) this.phaseWorst.set(phase, worst);
    }
  }

  drain(): FrameSpan | null {
    if (!this.frames) return null;
    const phases: FrameSpan["phases"] = {};
    for (const [phase, sum] of this.phaseSums) {
      phases[phase] = {
        mean: hundredths(sum / this.phaseReports),
        worst: hundredths(this.phaseWorst.get(phase) ?? 0),
      };
    }
    const span: FrameSpan = {
      spanMs: Math.round(this.spanMs),
      frames: this.frames,
      buckets: this.buckets,
      worstMs: Math.round(this.worstMs),
      gaps: this.gaps,
      phases,
    };
    this.buckets = new Array<number>(FRAME_BUCKETS).fill(0);
    this.frames = 0;
    this.worstMs = 0;
    this.gaps = 0;
    this.spanMs = 0;
    this.phaseSums.clear();
    this.phaseWorst.clear();
    this.phaseReports = 0;
    return span;
  }
}

function hundredths(ms: number): number {
  return Math.round(ms * 100) / 100;
}
