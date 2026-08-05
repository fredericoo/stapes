import { describe, expect, it } from "vitest";
import map from "../../data/map.json";
import tiles from "../../data/tiles.json";
import { PERF_BUDGETS } from "../editor/perf";
import {
  AMBIENT_PRESETS,
  computeLighting,
  overlayEmitterOverrides,
  staticLightingMapKey,
} from "./lighting";
import type { MapFile, TileDef } from "./types";
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
  const mapFile = map as MapFile;
  const omit = new Set([PLAYER_TILE_ID]);

  it(`full static bake p95 < ${BAKE_MS}ms on fixture map`, () => {
    // Warmup
    for (let i = 0; i < 3; i++) {
      computeLighting(mapFile, tilesById, AMBIENT_PRESETS.night, undefined, omit);
    }
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      computeLighting(mapFile, tilesById, AMBIENT_PRESETS.night, undefined, omit);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = percentile(samples, 95);
    expect(
      p95,
      `bake p95 ${p95.toFixed(2)}ms (p50=${percentile(samples, 50).toFixed(2)})`,
    ).toBeLessThanOrEqual(BAKE_MS);
  });

  it(`player overlay p95 < ${OVERLAY_MS}ms`, () => {
    const staticGrid = computeLighting(
      mapFile,
      tilesById,
      AMBIENT_PRESETS.night,
      undefined,
      omit,
    );
    const p = requireSinglePlayer(mapFile);
    const ov = [{ x: p.x, y: p.y, z: p.z, fx: p.x + 0.5, fy: p.y + 0.5, fz: p.z + 0.5 }];
    for (let i = 0; i < 3; i++) {
      overlayEmitterOverrides(staticGrid, mapFile, tilesById, ov);
    }
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      overlayEmitterOverrides(staticGrid, mapFile, tilesById, ov);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(percentile(samples, 95)).toBeLessThanOrEqual(OVERLAY_MS);
  });

  it("staticLightingMapKey ignores player moves", () => {
    const a = staticLightingMapKey(mapFile, omit);
    const b = staticLightingMapKey(mapFile, omit);
    expect(a).toBe(b);
  });
});
