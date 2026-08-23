import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PLAYWRIGHT_PORT ?? "5174";
const SERVER_PORT = process.env.PLAYWRIGHT_SERVER_PORT ?? "5175";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE,
    trace: "on-first-retry",
  },
  /**
   * Both halves, because `/map` is not a static page: the editor reads the
   * world over `/api`, which Vite proxies through to the Bun server beside it.
   *
   * The ports are pinned rather than picked. `scripts/dev.ts` asks the OS for
   * free ones by default — right for a person running several worktrees at
   * once, useless here, where the URL has to be known before the server exists.
   */
  webServer: {
    command: "bun run scripts/dev.ts",
    env: {
      STAPES_CLIENT_PORT: PORT,
      STAPES_SERVER_PORT: SERVER_PORT,
    },
    url: `${BASE}/map`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
