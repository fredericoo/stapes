# Testing

- `vitest.config.ts` sets `fileParallelism: false` because `app/lib/lighting.perf.test.ts` asserts on wall-clock percentiles.
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` (`e2e/accounts.ts`) and `SEEDED_ADMIN_PASSWORD` (`server/accounts.test.ts`, `server/api.test.ts`) are literals, not imports from `seedAdmin`, so changing the seeded password fails a test.
- Bundle tests create archives with `COPYFILE_DISABLE=1 tar` so macOS does not add AppleDouble `._` entries that CI archives lack.
