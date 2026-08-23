import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `app/` only. `server/` runs under `bun test` instead — see `test:server`
    // in package.json. The split is the same one this repo already had, and for
    // the same reason: pure logic runs in the fast generic runner, while the
    // world runs in the runtime it actually deploys to, against a real database.
    // Vitest cannot be that runner here — it drives tests through worker
    // threads, and the database is a native module that does not survive the
    // trip.
    include: ["app/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "e2e/**", ".worktrees/**"],
    /**
     * One test file at a time.
     *
     * `lighting.perf.test.ts` asserts on wall-clock percentiles, and vitest
     * otherwise runs files in parallel worker threads — so the bake races
     * whatever else is running and its p95 measures machine load as much as the
     * code. It went flaky the moment the suite gained another file, at a p50
     * less than half the budget.
     *
     * Costs a few seconds on a full run. The alternative is raising the
     * threshold until the noise fits under it, which is the same as deleting
     * the test.
     */
    fileParallelism: false,
  },
});
