# Testing

- `vitest.config.ts` sets `fileParallelism: false` because `app/lib/lighting.perf.test.ts` asserts on wall-clock percentiles.
- `TOWN_HALF_SPAN` (`app/lib/fixtureTown.ts`) keeps the fixture town near the shipped map's cell and quad counts, which the budgets in `app/editor/perf.ts` are measured against. `layPond` exists so the fixture has animated terrain for those budgets to measure.
- `e2e/renderer-perf.spec.ts` skips frame-time assertions when `PERF_SKIP_TIMING=1`. The p95 budget is 1ms locally and 8ms in CI.
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` (`e2e/accounts.ts`) and `SEEDED_ADMIN_PASSWORD` (`server/accounts.test.ts`) are literals, not imports from `seedAdmin`, so changing the seeded password fails a test.
- Bundle tests create archives with `COPYFILE_DISABLE=1 tar` so macOS does not add AppleDouble `._` entries that CI archives lack.
