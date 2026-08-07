/** Shared perf budgets — Playwright asserts these; tune when the map grows on purpose. */
export const PERF_BUDGETS = {
  /**
   * Draw calls with showOtherLevels on (grid + dimmed RT/composite passes +
   * current level + overlays). Lighting must not push this without raising it.
   */
  maxDrawCalls: 48,
  /** ~3k quads × 2 tris ≈ 6k; leave headroom for overlays/ghosts. */
  maxTriangles: 40_000,
  /**
   * World meshes should be O(levels × tilesets + animated), not O(quads).
   * Today: a handful of levels × ~1–2 tilesets + animated instances.
   */
  maxWorldMeshes: 64,
  /** Hard ceiling: meshes must stay well below placed quads (merged path). */
  maxMeshToQuadRatio: 0.05,
  /** Local — fail if p95 renderFrame exceeds this. */
  frameMsP95: 1,
  /** CI without a discrete GPU — looser timing; structure caps still apply. */
  frameMsP95Ci: 8,
  /**
   * Cold static lighting bake on fixture map (circular hybrid: Euclidean sky
   * spill + spherical torches). Half-blocks participate in sky flood.
   * Asserted in `app/lib/lighting.perf.test.ts` — not the editor frame probe.
   *
   * This runs synchronously on any non-player map change — a push landing, a
   * door switching — so the budget is counted in dropped frames, not in "does
   * it finish". Measures ~23ms p50 / ~46ms p95 today. The old 200ms ceiling
   * was wide enough to hide a 147ms stall, so keep this tight to the real
   * number and treat a regression as a visible hitch rather than a warning.
   */
  lightingBakeMsP95: 60,
  lightingBakeMsP95Ci: 110,
  /** Player light overlay atop cached bake. */
  lightingOverlayMsP95: 15,
  lightingOverlayMsP95Ci: 25,
} as const;

export type EditorPerfSnapshot = {
  lastFrameMs: number;
  calls: number;
  triangles: number;
  levels: number;
  worldMeshes: number;
  animated: number;
  placedQuads: number;
  showOtherLevels: boolean;
  currentLevel: number;
  previewMode: boolean;
};

export type EditorPerfMeasure = {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  calls: number;
  triangles: number;
  levels: number;
  worldMeshes: number;
  animated: number;
  placedQuads: number;
};

export type EditorPerfProbe = {
  ready: () => boolean;
  snapshot: () => EditorPerfSnapshot;
  /** Force N synchronous renderFrame passes and return timing percentiles. */
  measureRenders: (samples?: number) => EditorPerfMeasure;
};

declare global {
  interface Window {
    __editorPerf?: EditorPerfProbe;
  }
}
