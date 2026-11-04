import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "../e2e/accounts.ts";

const USAGE = `bun run scene <scene.json> --out <file.png> [--url <client origin>] [--size 480x480] [--scale 2]

Draws a hand-written scene with the game's own renderer and no game behind it,
and saves a screenshot of it. The scene format is \`Scene\` in app/lib/scene.ts.
Without --url it starts \`bun dev\` on free ports for the one shot and stops it.`;

const ADMIN = { username: ADMIN_USERNAME, password: ADMIN_PASSWORD };
const BOOT_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
/** Software GL, so the picture is the same with or without a GPU. */
const HEADLESS_GL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    url: { type: "string" },
    size: { type: "string", default: "480x480" },
    scale: { type: "string", default: "2" },
    help: { type: "boolean" },
  },
});

const scenePath = positionals[0];
if (values.help || !scenePath || !values.out) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const [width, height] = values.size.split("x").map(Number);
const scale = Number(values.scale);
if (!width || !height || !scale) {
  console.error(`--size is "${values.size}" and --scale is "${values.scale}". ${USAGE}`);
  process.exit(1);
}

const scene: unknown = JSON.parse(await readFile(scenePath, "utf8"));
const out = path.resolve(values.out);

/** The part of `window.__scene` (app/routes/admin/scene.tsx) this script calls. */
type SceneWindow = { __scene?: { render(scene: unknown): Promise<void> } };

const dev = values.url ? null : await startDev();
const origin = values.url ?? dev!.url;

try {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: HEADLESS_GL_ARGS,
  });
  const page = await browser.newPage({
    baseURL: origin,
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const signedIn = await page.request.post("/api/auth/sign-in/username", { data: ADMIN });
  if (!signedIn.ok()) throw new Error(`signing in as ${ADMIN.username}: ${signedIn.status()}`);

  await page.goto("/admin/scene", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as SceneWindow).__scene != null, null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.evaluate((s) => (window as SceneWindow).__scene!.render(s), scene);
  await page.locator("canvas").screenshot({ path: out });
  await browser.close();

  if (errors.length > 0) console.error(`page errors:\n${errors.join("\n")}`);
  console.log(
    `${path.relative(process.cwd(), out)} — ${scenePath}, ${width}x${height} at ${scale}x`,
  );
} finally {
  dev?.child.kill("SIGTERM");
}

async function startDev(): Promise<{ url: string; child: ChildProcess }> {
  const clientPort = await freePort();
  const serverPort = await freePort();
  const child = spawn("bun", ["scripts/dev.ts"], {
    stdio: "ignore",
    env: {
      ...process.env,
      STAPES_CLIENT_PORT: String(clientPort),
      STAPES_SERVER_PORT: String(serverPort),
    },
  });
  const url = `http://localhost:${clientPort}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
    const up = await fetch(`${url}/api/tilesets`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return { url, child };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  child.kill("SIGTERM");
  throw new Error(`bun dev did not answer on ${url} within ${BOOT_TIMEOUT_MS} ms`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Could not read back a port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}
