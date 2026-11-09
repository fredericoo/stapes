import * as v from "valibot";
import { FRAME_BUCKETS, FRAME_REPORT_INTERVAL_MS, type FrameReport } from "../app/net/frameReport";
import { FRAME_PHASES } from "../app/render/frameProfile";
import type { Database } from "./db";

export const MAX_FRAME_REPORT_BYTES = 4096;

/** A tab reports on a timer and when it is hidden, so two reports can arrive close together. */
export const FRAME_REPORT_MIN_GAP_MS = FRAME_REPORT_INTERVAL_MS / 10;

export const FRAME_LOG_KEPT_MS = 30 * 24 * 60 * 60_000;

export const FRAME_LOG_READ_LIMIT = 5000;

const PRUNE_INTERVAL_MS = 60 * 60_000;

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const duration = v.pipe(v.number(), v.minValue(0));
const short = v.pipe(v.string(), v.maxLength(64));
const phase = v.object({ mean: duration, worst: duration });

const schema = v.object({
  tab: short,
  build: v.nullable(short),
  spanMs: duration,
  frames: v.pipe(count, v.minValue(1)),
  buckets: v.pipe(v.array(count), v.length(FRAME_BUCKETS)),
  worstMs: duration,
  gaps: count,
  phases: v.object(Object.fromEntries(FRAME_PHASES.map((name) => [name, v.optional(phase)]))),
  canvas: short,
  lighting: v.boolean(),
  area: v.nullable(v.object({ x: v.number(), y: v.number(), z: v.number() })),
  device: v.object({
    userAgent: v.pipe(v.string(), v.maxLength(512)),
    platform: v.nullable(short),
    mobile: v.nullable(v.boolean()),
    screen: short,
    viewport: short,
    devicePixelRatio: v.number(),
    cores: v.nullable(v.number()),
    memoryGb: v.nullable(v.number()),
    gpu: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  }),
});

export type StoredFrameReport = FrameReport & { at: number };

export function readFrameReport(sent: unknown): FrameReport | null {
  const parsed = v.safeParse(schema, sent);
  return parsed.success ? (parsed.output as FrameReport) : null;
}

type Row = { at: number; report: string };

/**
 * A row holds no account. The sender must be signed in so that the endpoint is
 * not open to the internet, and the account is used only to space its reports.
 */
export class FrameLog {
  private readonly lastFrom = new Map<string, number>();
  private prunedAt = 0;

  constructor(private readonly db: Database) {}

  tooSoon(userId: string, now: number): boolean {
    const last = this.lastFrom.get(userId);
    return last !== undefined && now - last < FRAME_REPORT_MIN_GAP_MS;
  }

  async add(userId: string, report: FrameReport, now: number): Promise<void> {
    this.lastFrom.set(userId, now);
    const insert = await this.db.prepare("INSERT INTO frame_report (at, report) VALUES (?, ?)");
    await insert.run([now, JSON.stringify(report)]);
    if (now - this.prunedAt >= PRUNE_INTERVAL_MS) await this.prune(now);
  }

  async since(at: number): Promise<StoredFrameReport[]> {
    const select = await this.db.prepare(
      "SELECT at, report FROM frame_report WHERE at >= ? ORDER BY id DESC LIMIT ?",
    );
    const rows = (await select.all([at, FRAME_LOG_READ_LIMIT])) as Row[];
    return rows
      .map((row) => ({ ...(JSON.parse(row.report) as FrameReport), at: row.at }))
      .reverse();
  }

  private async prune(now: number): Promise<void> {
    this.prunedAt = now;
    const remove = await this.db.prepare("DELETE FROM frame_report WHERE at < ?");
    await remove.run([now - FRAME_LOG_KEPT_MS]);
    for (const [userId, last] of this.lastFrom) {
      if (now - last >= FRAME_REPORT_MIN_GAP_MS) this.lastFrom.delete(userId);
    }
  }
}
