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
   * spill + spherical torches). Half-blocks participate in sky flood, so local
   * p95 sits ~60–70ms on the fixture map.
   * Asserted in `app/lib/lighting.perf.test.ts` — not the editor frame probe.
   */
  lightingBakeMsP95: 80,
  lightingBakeMsP95Ci: 140,
  /** Player light overlay atop cached bake. */
  lightingOverlayMsP95: 5,
  lightingOverlayMsP95Ci: 10,
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
