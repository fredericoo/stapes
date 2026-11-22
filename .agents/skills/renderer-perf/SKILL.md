---
name: renderer-perf
description: >
  Runs the renderer and lighting performance budgets before shipping Three.js
  map mesh, lighting bake, or draw-call changes. Use when changing files under
  app/render/ or app/lib/lighting*, working on mesh building, lighting bake or
  overlay, or when shipping renderer work.
---

# Renderer performance gates

When you change map mesh building, the lighting bake, or anything under `app/render/` / `app/lib/lighting*` that can affect draw calls or frame time:

1. Before considering the work done, run `bun run test:unit`, which includes the bake and overlay budgets in `app/lib/lighting.perf.test.ts`.
2. Do not ship if it fails. If a budget in `app/lib/lightingBudgets.ts` must rise for a real feature (e.g. lighting passes), update the budget in the same change and say why in the PR/commit summary.
3. Prefer fixing regressions (draw calls, lighting bake ms) over raising caps.
4. `PERF_SKIP_TIMING=1` is only for diagnosing when the GPU is unavailable — not a way to ignore slow frames on a normal machine.
5. To *see* what the play renderer is keeping — meshed chunks, the lighting
   window, the client's subscription — open `/admin/play?debug=1` or `/?debug=1`
   (`[` and `]` zoom). It draws every window the renderer derives, and the panel
   reports how far past the view each one reaches. Undocumented in the game;
   `docs/notes.md` has the section. A frame time read in that mode includes the
   outlines, so take budgets without it.
6. There is no frame-time budget for a renderer in the browser. The one there
   was measured the old map editor's `EditorRenderer` (`e2e/renderer-perf.spec.ts`)
   and went with it; `/admin/compose` draws with the game's `WorldRenderer`.
