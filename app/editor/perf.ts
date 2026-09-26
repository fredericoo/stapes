export const PERF_BUDGETS = {
  maxDrawCalls: 180,
  maxTrianglesPerQuad: 4.5,
  maxWorldMeshes: 96,
  maxMeshToQuadRatio: 0.05,
  frameMsP95: 1,
  frameMsP95Ci: 8,
  lightingBakeMsP95: 65,
  lightingBakeMsP95Ci: 115,
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
  measureRenders: (samples?: number) => EditorPerfMeasure;
};

declare global {
  interface Window {
    __editorPerf?: EditorPerfProbe;
  }
}
