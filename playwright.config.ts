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
    baseURL: BASE,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.CHROMIUM_PATH },
      },
    },
    /**
     * Safari reads the game socket differently from Chrome, and once lost
     * every connection after its first frame while Chrome played normally. So
     * the specs that go through the socket run in WebKit as well.
     */
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: ["session.spec.ts", "socket.spec.ts"],
    },
  ],
  webServer: {
    command: "bun run scripts/dev.ts",
    env: {
      STAPES_CLIENT_PORT: PORT,
      STAPES_SERVER_PORT: SERVER_PORT,
      WEATHER: "clear",
    },
    url: `${BASE}/admin/map`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
