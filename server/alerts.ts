import { TICK_MS } from "../app/game/constants";
import type { TickSample } from "./tickLog";

export const ALERT_RULES = ["tick-slow", "world-slow", "tick-failing", "frames-slow"] as const;

export type AlertRule = (typeof ALERT_RULES)[number];

export type Finding = { rule: AlertRule; summary: string; detail: string[] };

export type FrameTally = { tabs: number; frames: number; slowShare: number };

export const ALERT_TITLES: Record<AlertRule, string> = {
  "tick-slow": "Server ticks are over budget",
  "world-slow": "The world is running slow",
  "tick-failing": "Server ticks are throwing",
  "frames-slow": "Players' frame rates dropped",
};

const TICK_SLOW_MINUTES = 3;

const TICK_WINDOW_MS = (TICK_SLOW_MINUTES + 0.5) * 60_000;

const LATEST_SAMPLE_MS = 1.5 * 60_000;

const WORLD_SLOW_SKIPPED_SHARE = 0.1;

const WORLD_SLOW_MIN_TICKS_DUE = 300;

export const FRAMES_SLOW_FLOOR = 0.05;

export const FRAMES_SLOW_FACTOR = 2;

export const FRAMES_MIN_TABS = 3;

export const FRAMES_MIN_FRAMES = 10_000;

/** A rule stops firing only after this long without a finding, so one good minute does not end and restart it. */
export const ALERT_CLEARS_AFTER_MS = 5 * 60_000;

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function phaseLines(sample: TickSample): string[] {
  return [
    `tick p50 ${sample.tick.p50}ms, p95 ${sample.tick.p95}ms, max ${sample.tick.max}ms`,
    `p95 by phase: sim ${sample.phases.sim.p95}ms, collect ${sample.phases.collect.p95}ms, broadcast ${sample.phases.broadcast.p95}ms, flush ${sample.phases.flush.p95}ms`,
    `late p95 ${sample.late.p95}ms, ${sample.players} players, ${sample.rssMb}MB`,
  ];
}

export function tickFindings(samples: readonly TickSample[], now: number): Finding[] {
  const recent = samples.filter((sample) => sample.at > now - TICK_WINDOW_MS);
  const latest = recent.at(-1);
  if (!latest) return [];
  const findings: Finding[] = [];

  if (recent.length >= TICK_SLOW_MINUTES && recent.every((sample) => sample.tick.p95 > TICK_MS)) {
    findings.push({
      rule: "tick-slow",
      summary: `Tick p95 has been over ${Math.round(TICK_MS)}ms for ${TICK_SLOW_MINUTES} minutes, now ${latest.tick.p95}ms.`,
      detail: phaseLines(latest),
    });
  }

  const ran = recent.reduce((sum, sample) => sum + sample.ticks, 0);
  const skipped = recent.reduce((sum, sample) => sum + sample.skipped, 0);
  const due = ran + skipped;
  if (due >= WORLD_SLOW_MIN_TICKS_DUE && skipped / due > WORLD_SLOW_SKIPPED_SHARE) {
    findings.push({
      rule: "world-slow",
      summary: `${percent(skipped / due)} of ticks were skipped over the last ${TICK_SLOW_MINUTES} minutes (${skipped} of ${due}).`,
      detail: phaseLines(latest),
    });
  }

  if (latest.at > now - LATEST_SAMPLE_MS && latest.failures > 0) {
    findings.push({
      rule: "tick-failing",
      summary: `${latest.failures} of ${latest.ticks} ticks threw in the last minute. The error is in the server log.`,
      detail: phaseLines(latest),
    });
  }
  return findings;
}

export function frameFinding(current: FrameTally, baseline: FrameTally): Finding | null {
  if (current.tabs < FRAMES_MIN_TABS || current.frames < FRAMES_MIN_FRAMES) return null;
  const known = baseline.frames >= FRAMES_MIN_FRAMES;
  const limit = Math.max(FRAMES_SLOW_FLOOR, known ? baseline.slowShare * FRAMES_SLOW_FACTOR : 0);
  if (current.slowShare <= limit) return null;
  return {
    rule: "frames-slow",
    summary: `${percent(current.slowShare)} of frames were slower than 30 a second in the last half hour, across ${current.tabs} tabs.`,
    detail: [
      known
        ? `the day before: ${percent(baseline.slowShare)} across ${baseline.tabs} tabs`
        : "no earlier reports to compare with",
    ],
  };
}

export type AlertChange = { started: Finding[]; cleared: AlertRule[] };

export class AlertBook {
  private readonly lastFound = new Map<AlertRule, number>();

  update(findings: readonly Finding[], now: number): AlertChange {
    const started = findings.filter((finding) => !this.lastFound.has(finding.rule));
    for (const finding of findings) this.lastFound.set(finding.rule, now);

    const cleared: AlertRule[] = [];
    for (const [rule, at] of this.lastFound) {
      if (now - at < ALERT_CLEARS_AFTER_MS) continue;
      this.lastFound.delete(rule);
      cleared.push(rule);
    }
    return { started, cleared };
  }

  get firing(): AlertRule[] {
    return [...this.lastFound.keys()];
  }
}
