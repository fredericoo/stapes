import { describe, expect, it } from "bun:test";
import { ALERT_CLEARS_AFTER_MS, AlertBook, frameFinding, tickFindings } from "./alerts";
import type { TickSample } from "./tickLog";

const MINUTE = 60_000;

function sample(
  at: number,
  over: { p95?: number; skipped?: number; failures?: number },
): TickSample {
  const spread = { p50: 4, p95: over.p95 ?? 8, p99: 12, max: 20 };
  return {
    at,
    ticks: 1800 - (over.skipped ?? 0),
    skipped: over.skipped ?? 0,
    failures: over.failures ?? 0,
    tick: spread,
    late: spread,
    phases: { sim: spread, collect: spread, broadcast: spread, flush: spread },
    players: 10,
    rssMb: 300,
  };
}

function rules(samples: TickSample[], now: number): string[] {
  return tickFindings(samples, now).map((finding) => finding.rule);
}

describe("tick findings", () => {
  const now = 10 * MINUTE;

  it("finds ticks over budget only once three minutes in a row were", () => {
    const slow = (minute: number) => sample(minute * MINUTE, { p95: 41 });

    expect(rules([slow(9), slow(10)], now)).toEqual([]);
    expect(rules([slow(8), sample(9 * MINUTE, {}), slow(10)], now)).toEqual([]);
    expect(rules([slow(8), slow(9), slow(10)], now)).toEqual(["tick-slow"]);
  });

  it("finds a slow world from the share of ticks skipped, not from one skipped tick", () => {
    const skipping = (minute: number, skipped: number) => sample(minute * MINUTE, { skipped });

    expect(rules([skipping(8, 0), skipping(9, 3), skipping(10, 0)], now)).toEqual([]);
    expect(rules([skipping(8, 200), skipping(9, 250), skipping(10, 300)], now)).toEqual([
      "world-slow",
    ]);
  });

  it("finds ticks that threw in the last minute, and not ones from before a quiet spell", () => {
    expect(rules([sample(10 * MINUTE, { failures: 2 })], now)).toEqual(["tick-failing"]);
    expect(rules([sample(10 * MINUTE, { failures: 2 })], now + 3 * MINUTE)).toEqual([]);
  });
});

describe("the frame finding", () => {
  const usual = { tabs: 40, frames: 2_000_000, slowShare: 0.04 };

  it("needs slow frames at twice the day's share, and over the floor", () => {
    const now = (slowShare: number) => ({ tabs: 8, frames: 100_000, slowShare });

    expect(frameFinding(now(0.07), usual)).toBeNull();
    expect(frameFinding(now(0.09), usual)?.rule).toBe("frames-slow");
    expect(frameFinding(now(0.03), { ...usual, slowShare: 0.01 })).toBeNull();
  });

  it("says nothing on the reports of a couple of tabs", () => {
    expect(frameFinding({ tabs: 2, frames: 100_000, slowShare: 0.5 }, usual)).toBeNull();
  });
});

describe("an alert book", () => {
  const finding = { rule: "tick-slow" as const, summary: "", detail: [] };

  it("starts a rule once, and clears it only after five minutes without a finding", () => {
    const book = new AlertBook();

    expect(book.update([finding], 0).started).toEqual([finding]);
    expect(book.update([finding], MINUTE)).toEqual({ started: [], cleared: [] });
    expect(book.update([], MINUTE + ALERT_CLEARS_AFTER_MS - 1)).toEqual({
      started: [],
      cleared: [],
    });
    expect(book.update([finding], 2 * MINUTE + ALERT_CLEARS_AFTER_MS)).toEqual({
      started: [],
      cleared: [],
    });
    expect(book.update([], 2 * MINUTE + 2 * ALERT_CLEARS_AFTER_MS).cleared).toEqual(["tick-slow"]);
    expect(book.update([finding], 3 * MINUTE + 2 * ALERT_CLEARS_AFTER_MS).started).toEqual([
      finding,
    ]);
  });
});
