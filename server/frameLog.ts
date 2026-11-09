import * as v from "valibot";
import { FRAME_BUCKETS, FRAME_REPORT_INTERVAL_MS, type FrameReport } from "../app/net/frameReport";
import { FRAME_PHASES } from "../app/render/frameProfile";
import { slowShare } from "../app/lib/frameSummary";
import type { FrameTally } from "./alerts";
import type { Database } from "./db";

export const MAX_FRAME_REPORT_BYTES = 4096;

/** A tab reports on a timer and when it is hidden, so two reports can arrive close together. */
export const FRAME_REPORT_MIN_GAP_MS = FRAME_REPORT_INTERVAL_MS / 10;

export const FRAME_LOG_KEPT_MS = 30 * 24 * 60 * 60_000;

export const FRAME_LOG_READ_LIMIT = 5000;

const PRUNE_INTERVAL_MS = 60 * 60_000;

export const FRAME_CURRENT_MS = 30 * 60_000;

export const FRAME_BASELINE_MS = 24 * 60 * 60_000;

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

type Recent = { at: number; tab: string; frames: number; slow: number; software: boolean };

/** Headless browsers draw without a GPU, and their frame times say nothing about a player's. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software/i;

function recentOf(report: FrameReport, at: number): Recent {
  const frames = report.buckets.reduce((sum, count) => sum + count, 0);
  return {
    at,
    tab: report.tab,
    frames,
    slow: Math.round(slowShare(report.buckets) * frames),
    software: SOFTWARE_RENDERER.test(report.device.gpu ?? ""),
  };
}

function tallyOf(recent: readonly Recent[]): FrameTally {
  const drawn = recent.filter((one) => !one.software);
  const frames = drawn.reduce((sum, one) => sum + one.frames, 0);
  const slow = drawn.reduce((sum, one) => sum + one.slow, 0);
  return {
    tabs: new Set(drawn.map((one) => one.tab)).size,
    frames,
    slowShare: frames ? slow / frames : 0,
  };
}

/**
 * A row holds no account. The sender must be signed in so that the endpoint is
 * not open to the internet, and the account is used only to space its reports.
 */
export class FrameLog {
  private readonly lastFrom = new Map<string, number>();
  private prunedAt = 0;
  private recent: Recent[] = [];

  constructor(private readonly db: Database) {}

  /** Fills the tallies from what a previous process stored, so a restart does not lose the day they compare against. */
  async load(now: number): Promise<void> {
    this.recent = (await this.since(now - FRAME_BASELINE_MS)).map((report) =>
      recentOf(report, report.at),
    );
  }

  /** The last half hour, and the rest of the last day before it. */
  tallies(now: number): { current: FrameTally; baseline: FrameTally } {
    this.recent = this.recent.filter((one) => one.at > now - FRAME_BASELINE_MS);
    const split = now - FRAME_CURRENT_MS;
    return {
      current: tallyOf(this.recent.filter((one) => one.at > split)),
      baseline: tallyOf(this.recent.filter((one) => one.at <= split)),
    };
  }

  tooSoon(userId: string, now: number): boolean {
    const last = this.lastFrom.get(userId);
    return last !== undefined && now - last < FRAME_REPORT_MIN_GAP_MS;
  }

  async add(userId: string, report: FrameReport, now: number): Promise<void> {
    this.lastFrom.set(userId, now);
    this.recent.push(recentOf(report, now));
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
