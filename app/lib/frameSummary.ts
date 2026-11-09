import { FRAME_BUCKETS, framePercentileMs, type FrameReport } from "../net/frameReport";

/** The first bucket of frames slower than thirty a second; see `FRAME_BUCKET_EDGES_MS`. */
export const SLOW_FRAME_BUCKET = 5;

export const FRAME_GROUPINGS = ["build", "gpu", "canvas", "device", "area"] as const;

export type FrameGrouping = (typeof FRAME_GROUPINGS)[number];

export type FrameGroup = {
  key: string;
  tabs: number;
  frames: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  slowShare: number;
  worstMs: number;
};

function keyOf(report: FrameReport, by: FrameGrouping): string {
  switch (by) {
    case "build":
      return report.build?.slice(0, 7) ?? "unknown";
    case "gpu":
      return report.device.gpu ?? "unknown";
    case "canvas":
      return `${report.canvas} @${report.device.devicePixelRatio}x`;
    case "device":
      return `${report.device.platform ?? "unknown"}${report.device.mobile ? " (mobile)" : ""}, ${report.device.screen}`;
    case "area":
      return report.area ? `${report.area.x} ${report.area.y} ${report.area.z}` : "unknown";
  }
}

export function slowShare(buckets: readonly number[]): number {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  const slow = buckets.slice(SLOW_FRAME_BUCKET).reduce((sum, count) => sum + count, 0);
  return slow / total;
}

/** Groups are ordered by the share of slow frames, worst first. */
export function groupFrameReports(
  reports: readonly FrameReport[],
  by: FrameGrouping,
): FrameGroup[] {
  const groups = new Map<string, { buckets: number[]; tabs: Set<string>; worstMs: number }>();
  for (const report of reports) {
    const key = keyOf(report, by);
    let group = groups.get(key);
    if (!group) {
      group = { buckets: new Array<number>(FRAME_BUCKETS).fill(0), tabs: new Set(), worstMs: 0 };
      groups.set(key, group);
    }
    report.buckets.forEach((count, index) => (group.buckets[index]! += count));
    group.tabs.add(report.tab);
    group.worstMs = Math.max(group.worstMs, report.worstMs);
  }
  return [...groups]
    .map(([key, { buckets, tabs, worstMs }]) => ({
      key,
      tabs: tabs.size,
      frames: buckets.reduce((sum, count) => sum + count, 0),
      p50Ms: framePercentileMs(buckets, 0.5),
      p95Ms: framePercentileMs(buckets, 0.95),
      p99Ms: framePercentileMs(buckets, 0.99),
      slowShare: slowShare(buckets),
      worstMs,
    }))
    .sort((a, b) => b.slowShare - a.slowShare || b.frames - a.frames);
}
