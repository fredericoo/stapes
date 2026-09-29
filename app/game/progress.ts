export type Progress = {
  remainingMs: number;
  durationMs: number;
};

export function progressFraction(progress: Progress): number {
  if (progress.durationMs <= 0) return 1;
  const done = 1 - progress.remainingMs / progress.durationMs;
  return Math.max(0, Math.min(1, done));
}

export function windProgress(progress: Progress, dtMs: number) {
  progress.remainingMs = Math.max(0, progress.remainingMs - dtMs);
}
