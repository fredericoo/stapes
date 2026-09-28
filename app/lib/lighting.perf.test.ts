import { describe, expect, it } from "vitest";
import { fixtureTown } from "./fixtureTown";
import tiles from "../../data/tiles.json";
import { PERF_BUDGETS } from "../editor/perf";
import { AMBIENT_PRESETS, computeLighting, overlayEmitterOverrides } from "./lighting";
import type { TileDef } from "./types";
import { PLAYER_TILE_ID } from "../game/constants";
import { requireSinglePlayer } from "../game/player";

/** Claude Code's cloud sessions run on shared VMs, as CI does, but do not set `CI`. */
const CI_BUDGETS =
  !!process.env.CI ||
  process.env.CLAUDE_CODE_REMOTE === "true" ||
  process.env.PERF_SKIP_TIMING === "1";

const BAKE_MS = CI_BUDGETS ? PERF_BUDGETS.lightingBakeMsP50Ci : PERF_BUDGETS.lightingBakeMsP50;
const OVERLAY_MS = CI_BUDGETS
  ? PERF_BUDGETS.lightingOverlayMsP95Ci
  : PERF_BUDGETS.lightingOverlayMsP95;

const WARMUP_RUNS = 3;

const SAMPLES = 100;

const TIMEOUT_SLACK = 2;

function timeoutFor(budgetMs: number): number {
  return (WARMUP_RUNS + SAMPLES) * budgetMs * TIMEOUT_SLACK;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

describe("lighting bake perf", () => {
  const tilesById = Object.fromEntries((tiles as TileDef[]).map((t) => [t.id, t])) as Record<
    string,
    TileDef
  >;
  const mapFile = fixtureTown();
  const omit = new Set([PLAYER_TILE_ID]);

  it(
    `full static bake p50 < ${BAKE_MS}ms on the fixture town`,
    () => {
      for (let i = 0; i < WARMUP_RUNS; i++) {
        computeLighting(mapFile, tilesById, AMBIENT_PRESETS.night, undefined, omit);
      }
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        computeLighting(mapFile, tilesById, AMBIENT_PRESETS.night, undefined, omit);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      /**
       * A shared VM runs at about half speed for stretches several bakes long,
       * so the p95 of back-to-back bakes lands inside one and measures the host.
       * The p50 holds as long as those stretches cover less than half the run.
       */
      const p50 = percentile(samples, 50);
      expect(
        p50,
        `bake p50 ${p50.toFixed(2)}ms (p95=${percentile(samples, 95).toFixed(2)})`,
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
      const ov = [{ x: p.x, y: p.y, z: p.z, fx: p.x + 0.5, fy: p.y + 0.5, fz: p.z + 0.5 }];
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
});
