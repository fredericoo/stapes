---
name: renderer-perf
description: >
  Runs editor/renderer performance budgets before shipping Three.js editor,
  map mesh, lighting bake, or draw-call changes. Use when changing files under
  app/editor/ or app/lib/lighting*, working on renderFrame, mesh building,
  lighting bake, overlay, or when shipping editor renderer work.
---

# Renderer performance gates

When you change the Three.js editor renderer, map mesh building, lighting bake, or anything under `app/editor/` / `app/lib/lighting*` that can affect draw calls or frame time:

1. Before considering the work done, run:
   - `pnpm test:unit` (includes `app/lib/lighting.perf.test.ts` bake/overlay budgets)
   - `pnpm test:perf` (editor renderFrame + structure caps)
2. Do not ship if either fails. If a budget in `app/editor/perf.ts` must rise for a real feature (e.g. lighting passes), update the budget in the same change and say why in the PR/commit summary.
3. Prefer fixing regressions (draw calls, mesh/quad ratio, frame p95, lighting bake ms) over raising caps.
4. `PERF_SKIP_TIMING=1` is only for diagnosing structure asserts when the GPU is unavailable — not a way to ignore slow frames on a normal machine.
5. Editor frame p95 does **not** measure cold lighting bake — that is gated separately via `PERF_BUDGETS.lightingBakeMsP95`.
