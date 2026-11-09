import type { FramePhase } from "../render/frameProfile";

/**
 * Upper edges of every bucket but the last, which is open. They sit between the
 * frame intervals of 120, 90, 60, 45, 30 and 20 frames a second, so a display's
 * own rate fills one bucket and a missed frame lands in a later one.
 */
export const FRAME_BUCKET_EDGES_MS = [9.5, 12.5, 19, 25, 37, 60, 120] as const;

export const FRAME_BUCKETS = FRAME_BUCKET_EDGES_MS.length + 1;

/** A frame at least this long after the last one means the tab was not being drawn. */
export const FRAME_GAP_MS = 1000;

export const FRAME_REPORT_INTERVAL_MS = 5 * 60_000;

export const FRAME_REPORT_PATH = "/api/perf/frames";

export type FrameSpan = {
  spanMs: number;
  frames: number;
  buckets: number[];
  worstMs: number;
  gaps: number;
  phases: Partial<Record<FramePhase, { mean: number; worst: number }>>;
};

export type FrameDevice = {
  userAgent: string;
  platform: string | null;
  mobile: boolean | null;
  screen: string;
  viewport: string;
  devicePixelRatio: number;
  cores: number | null;
  memoryGb: number | null;
  gpu: string | null;
};

export type FrameReport = FrameSpan & {
  tab: string;
  build: string | null;
  canvas: string;
  lighting: boolean;
  area: { x: number; y: number; z: number } | null;
  device: FrameDevice;
};

export function frameBucket(ms: number): number {
  const index = FRAME_BUCKET_EDGES_MS.findIndex((edge) => ms < edge);
  return index === -1 ? FRAME_BUCKETS - 1 : index;
}

/** The upper edge of the bucket holding that fraction of the frames, which for the last bucket is `Infinity`. */
export function framePercentileMs(buckets: readonly number[], fraction: number): number {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  let seen = 0;
  for (let index = 0; index < buckets.length; index++) {
    seen += buckets[index]!;
    if (seen >= total * fraction) return FRAME_BUCKET_EDGES_MS[index] ?? Infinity;
  }
  return Infinity;
}
