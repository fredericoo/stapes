import { describe, expect, it } from "vitest";
import { chunkifyMap } from "./mapData";
import type { FlatMapFile } from "./types";
import map from "../../data/map.json";
import tiles from "../../data/tiles.json";
import { PERF_BUDGETS } from "../editor/perf";
import {
  AMBIENT_PRESETS,
  computeLighting,
  overlayEmitterOverrides,
  staticLightingMapKey,
} from "./lighting";
import type { TileDef } from "./types";
import { PLAYER_TILE_ID } from "../game/constants";
import { requireSinglePlayer } from "../game/player";

const BAKE_MS =
  process.env.CI || process.env.PERF_SKIP_TIMING === "1"
    ? PERF_BUDGETS.lightingBakeMsP95Ci
    : PERF_BUDGETS.lightingBakeMsP95;
const OVERLAY_MS =
  process.env.CI || process.env.PERF_SKIP_TIMING === "1"
    ? PERF_BUDGETS.lightingOverlayMsP95Ci
    : PERF_BUDGETS.lightingOverlayMsP95;

/** Bakes thrown away before timing, so the JIT is warm and the caches are hot. */
const WARMUP_RUNS = 3;

/**
 * How many bakes a percentile is taken over.
 *
 * Large enough that p95 is a percentile rather than a near-maximum. At twenty
 * samples the 95th is the second-worst of the run, so a single GC pause — about
 * one bake in fifty, and three times the median when it lands — was reported as
 * the p95 and failed a run the baker had nothing to do with. At a hundred it is
 * the sixth-worst, which those pauses no longer reach.
 *
 * The alternative was a budget wide enough to contain them, which is a budget
 * wide enough to contain a real regression. Sampling is the cheaper half.
 */
const SAMPLES = 100;

/**
 * How long a run may take before vitest calls it hung, from the budget it is
 * allowed to spend per sample.
 *
 * Derived rather than left at the default five seconds, which a hundred samples
 * can now outlast on a machine that is merely slow rather than broken — the CI
 * budget permits it, so a fixed timeout would fail runs the assertion below
 * would have passed, and the message would say "timed out" rather than name the
 * number. Doubled so the slack is the machine's, not the budget's.
 */
const TIMEOUT_SLACK = 2;

function timeoutFor(budgetMs: number): number {
  return (WARMUP_RUNS + SAMPLES) * budgetMs * TIMEOUT_SLACK;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[i]!;
}

describe("lighting bake perf", () => {
  const tilesById = Object.fromEntries(
    (tiles as TileDef[]).map((t) => [t.id, t]),
  ) as Record<string, TileDef>;
  const mapFile = chunkifyMap(map as FlatMapFile);
  const omit = new Set([PLAYER_TILE_ID]);

  it(
    `full static bake p95 < ${BAKE_MS}ms on fixture map`,
    () => {
      for (let i = 0; i < WARMUP_RUNS; i++) {
        computeLighting(
          mapFile,
          tilesById,
          AMBIENT_PRESETS.night,
          undefined,
          omit,
        );
      }
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        computeLighting(
          mapFile,
          tilesById,
          AMBIENT_PRESETS.night,
          undefined,
          omit,
        );
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const p95 = percentile(samples, 95);
      expect(
        p95,
        `bake p95 ${p95.toFixed(2)}ms (p50=${percentile(samples, 50).toFixed(2)})`,
      ).toBeLessThanOrEqual(BAKE_MS);
    },
    timeoutFor(BAKE_MS),
  );

  it(
    `player overlay p95 < ${OVERLAY_MS}ms`,
    () => {
      const staticGrid = computeLighting(
        mapFile,
        tilesById,
        AMBIENT_PRESETS.night,
        undefined,
        omit,
      );
      const p = requireSinglePlayer(mapFile);
      const ov = [
        { x: p.x, y: p.y, z: p.z, fx: p.x + 0.5, fy: p.y + 0.5, fz: p.z + 0.5 },
      ];
      for (let i = 0; i < WARMUP_RUNS; i++) {
        overlayEmitterOverrides(staticGrid, mapFile, tilesById, ov);
      }
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        overlayEmitterOverrides(staticGrid, mapFile, tilesById, ov);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      expect(percentile(samples, 95)).toBeLessThanOrEqual(OVERLAY_MS);
    },
    timeoutFor(OVERLAY_MS),
  );

  it("staticLightingMapKey ignores player moves", () => {
    const a = staticLightingMapKey(mapFile, omit);
    const b = staticLightingMapKey(mapFile, omit);
    expect(a).toBe(b);
  });
});
