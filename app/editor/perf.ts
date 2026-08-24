/** Shared perf budgets — Playwright asserts these; tune when the map grows on purpose. */
export const PERF_BUDGETS = {
  /**
   * Draw calls with showOtherLevels on (grid + every solid level in one pass +
   * one fused ghost RT and its composite + overlays). Lighting must not push
   * this without raising it.
   *
   * Set to the ceiling for a full building rather than to the fixture, because
   * calls track *floors* and the floor count has a hard limit: `MIN_LEVEL` to
   * `MAX_LEVEL` is seventeen, and a map that uses all of them is a map somebody
   * is allowed to author. Measured by filling every one of the seventeen with a
   * copy of the fixture's surface level, which is the most expensive floor
   * there is to draw — it is the one that uses all five tilesets, and animated
   * instances and torches with them: 174 calls. The same fill with the cave
   * level, which uses three, costs 168, so the last two tilesets are worth
   * about six calls across the whole building and the number is near enough
   * saturated. 180 is that with the rounding left on.
   *
   * What a floor costs depends on what is on it, between about two calls for a
   * floor of one tile and about ten for one with all five tilesets. The fixture
   * measures 56 over ten floors, so this ceiling is deliberately far above what
   * it draws today: it is here to catch a sixth tileset or a per-torch pass,
   * and a map that approaches it fails the frame budget below first — the
   * seventeen-floor fill measures 1.5ms p95 locally against a budget of 1.
   *
   * Was 60, which the fixture's own growth was already within four calls of.
   * Before that 48 against a measured 42, when the editor hid the underworld
   * while you stood on the surface. It draws it now — like play does — and the
   * cave under the fixture map brings a torch per draw call with it: 50
   * measured. Fusing the ghosts into one composite paid seven of those back.
   */
  maxDrawCalls: 180,
  /**
   * Total triangles, as an alarm for the map rather than for the renderer.
   *
   * A ceiling in absolute triangles can only ever say "the fixture grew", and
   * it says it by failing — this was 40k against a 7.3k-quad map, and the
   * tutorial's 29.6k quads walked straight through it at 118k. The walled
   * city took it from 31k quads / 124k tris to 38.6k / 154k against the 150k
   * this replaces. What it is still worth keeping for is the case where a map
   * grows so far that the frame budget below is next, so raise it deliberately
   * with the map and read a failure here as "look at the map", not "look at
   * the renderer".
   *
   * Whether the *renderer* regressed is {@link maxTrianglesPerQuad}'s question.
   */
  maxTriangles: 200_000,
  /**
   * Triangles per placed quad — the renderer's own share, independent of how
   * big the map is.
   *
   * Measures 4.0 and has not moved: 29,184 tris over 7,305 quads before the
   * tutorial, 118,480 over 29,631 after. Content scaled 4× and the ratio did
   * not, which is the merged path doing its job. A regression that starts
   * emitting extra geometry per tile — an unmerged overlay, a second pass, a
   * ghost drawn solid — moves this and nothing else, and moves it on any map,
   * which is why it is the assertion that does not need re-baselining.
   */
  maxTrianglesPerQuad: 4.5,
  /**
   * World meshes should be O(levels × tilesets + animated), not O(quads).
   * Today: a handful of levels × ~1–2 tilesets + animated instances. The
   * walled city measures 75 — it lit its streets and buildings with torches
   * (animated, so each occupied level adds instances) and put a roof on a
   * sixth level. Still O(levels × tilesets + animated); the ratio guard below
   * is what would catch a real O(quads) regression.
   */
  maxWorldMeshes: 96,
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
   * it finish". The old 200ms ceiling was wide enough to hide a 147ms stall,
   * so keep this tight to the real number and treat a regression as a visible
   * hitch rather than a warning.
   *
   * Was 40/70 against ~25ms p50 / ~28ms p95, on the map before the walled
   * city. The city grew the fixture again — 16.3k cells to 20.9k, and 10
   * torches to 46 — for 1.6× the bake (torches cost more than cells: each is
   * its own spherical flood). Same code, bigger map.
   *
   * Was 30/55 against ~13ms p50 / ~19ms p95, which is what the same code still
   * measures on the map as it stood before the tutorial. The tutorial did not
   * make the bake slower; it made the fixture bigger — 5.2k cells to 16.5k, for
   * 1.9× the time. This is the budget growing with the map on purpose, so the
   * number to compare a future regression against is the p50 above.
   *
   * Was 60/110 against ~23ms p50 / ~46ms p95, before the sky flood learned to
   * seed only its frontier and the gather stopped asking every wall tile
   * whether it was a lamp.
   *
   * Deliberately not wide enough to swallow the occasional 50–60ms bake: one
   * run in fifty or so is a GC pause rather than the baker, and the test takes
   * enough samples that those land outside the percentile instead of being
   * budgeted for. A ceiling raised to cover them would also cover a real 2×.
   *
   * The gap over the measured p95 is for the machine rather than for the code:
   * a laptop under load runs the whole distribution ~8% slower, and a budget
   * with no room for that fails on a busy afternoon and teaches everyone to
   * re-run it. 1.4× the p95 is a slightly tighter ratio than the 30 this
   * replaces held over its own.
   */
  lightingBakeMsP95: 65,
  lightingBakeMsP95Ci: 115,
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
