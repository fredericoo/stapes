# Testing

- `vitest.config.ts` sets `fileParallelism: false` because `app/lib/lighting.perf.test.ts` asserts on wall-clock percentiles.
- `app/lib/lighting.perf.test.ts` takes the `Ci` budgets in `app/editor/perf.ts` in Claude Code's cloud sessions too (`CLAUDE_CODE_REMOTE=true`), which bake the fixture town slower than GitHub's runners do: 48–53ms at best and 59–72ms at the median, against a 39–55ms mean on GitHub. A `Ci` budget tightened to fit GitHub's numbers fails there.
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` (`e2e/accounts.ts`) and `SEEDED_ADMIN_PASSWORD` (`server/accounts.test.ts`, `server/api.test.ts`) are literals, not imports from `seedAdmin`, so changing the seeded password fails a test.
- `scripts/record-hero.ts` imports the `e2e/accounts.ts` pair instead of keeping its own copy, so updating that pair for a new seeded password updates the script too. The script runs under Node, which resolves a relative import only when its path ends in the file's extension, so an extensionless import added to `e2e/accounts.ts` breaks the script and fails no test.
- Bundle tests create archives with `COPYFILE_DISABLE=1 tar` so macOS does not add AppleDouble `._` entries that CI archives lack.
