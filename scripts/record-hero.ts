/**
 * Records the landing page's hero video: a character walking through town with
 * no interface on screen.
 *
 *   bun dev                                         # in another terminal
 *   node scripts/record-hero.ts http://localhost:5173
 *
 * Writes `public/home/hero.webm`, `hero.mp4` and the poster, `hero.jpg`. Needs
 * `ffmpeg` on the path, and `CHROMIUM_PATH` if Playwright's own Chromium is not
 * installed.
 *
 * Node rather than Bun: under Bun, Playwright's request context fails to parse
 * the sign-in response's cookie and the request times out. Node 22 runs the
 * TypeScript as it is.
 *
 * Re-run it when the town changes enough that the video
 * no longer shows the town people will walk into.
 *
 * ## What it records
 *
 * `/admin/play`, signed in as the seeded administrator, because that route runs
 * the world in the tab: no other players, nothing on the wire, and `/time` and
 * `/goto` are accepted. It sets the hour, puts the body at {@link START}, hides
 * the label layer (names, health bars, notices), and holds arrow keys for the
 * durations in {@link ROUTE} while Chrome's screencast captures the page.
 *
 * ## Why time is slowed down
 *
 * A headless browser without a GPU draws WebGL in software, at 6 to 16 frames a
 * second on the machines this was written on. Recorded in real time, that is
 * the frame rate of the video. So page time runs at {@link SLOW} of real time:
 * `performance.now`, `Date.now`, `requestAnimationFrame` timestamps and timer
 * delays are all scaled, and the frames are retimed by the same factor when the
 * video is encoded. A body that walks one tile per 200 ms of page time walks one
 * tile per 200 ms of video.
 *
 * **The world's worker is slowed too, from the same epoch.** It is where the
 * simulation runs, and it has its own clock. Left at real speed, it accepts
 * steps and moves creatures five times faster than the page draws them. The
 * patch is loaded into it as a module imported before the worker's own, so it
 * runs first and the worker's message handler is still registered in its first
 * turn; loading the worker with a dynamic `import()` instead drops the messages
 * the page sends before that import finishes, and the world never connects.
 *
 * Faking the clock outright (Playwright's `page.clock`) does not work here:
 * with time stopped between frames, anything that works to a time budget never
 * reaches the end of its budget, and each frame takes tens of seconds.
 *
 * ## Why the canvas is a whole multiple of the view
 *
 * The play view is 184 world pixels square, and the renderer draws it at a
 * whole-number scale (`app/render/viewport.ts`). The viewport is sized so the
 * canvas is exactly {@link SCALE} times that in CSS pixels. Any other size and
 * the browser resamples the frame to fit, which blurs pixel art before it is
 * recorded. ffmpeg then doubles it with nearest-neighbour scaling.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hour of day. Daylight is flat from 09:00 to 16:00 (`app/lib/clock.ts`). */
const TIME = "13:00";
/** Where the walk starts: the west end of the main road. */
const START = "/goto -34 0 0";
/** Keys to hold and for how long, in milliseconds of video. */
const ROUTE: [key: string | null, ms: number][] = [
  [null, 800],
  // East along the main road to the crossroads at x = 3, one tile per 200 ms.
  ["ArrowRight", 7400],
  // North up the side road to the market street at y = -19.
  ["ArrowUp", 3800],
  // East along the market street, stopping short of the houses at its end.
  ["ArrowRight", 3000],
  [null, 600],
];
/** Page time per real time while recording. */
const SLOW = 0.1;
/** CSS pixels per world pixel on the recorded canvas. */
const SCALE = 3;
/** Side of the play view in world pixels. @see app/render/viewport.ts */
const VIEW_PX = 184;
/** Height of the chat bar under the canvas on `/admin/play`. */
const CHAT_BAR_PX = 48;
const FPS = 30;

const ADMIN = { username: "admin", password: "salem123" };
const OUT_DIR = join(import.meta.dirname, "..", "public", "home");

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/record-hero.ts <client url, as printed by bun dev>");
  process.exit(1);
}

const epoch = Date.now();
const timePatch = `(() => {
  const F = ${SLOW}, E = ${epoch};
  const realDate = Date.now.bind(Date), pn = performance.now.bind(performance);
  const v = () => pn() * F;
  performance.now = v;
  Date.now = () => Math.floor(E + (realDate() - E) * F);
  if (self.requestAnimationFrame) {
    const raf = self.requestAnimationFrame.bind(self);
    self.requestAnimationFrame = (cb) => raf(() => cb(v()));
  }
  const st = self.setTimeout.bind(self), si = self.setInterval.bind(self);
  self.setTimeout = (fn, ms = 0, ...a) => st(fn, (Number(ms) || 0) / F, ...a);
  self.setInterval = (fn, ms = 0, ...a) => si(fn, (Number(ms) || 0) / F, ...a);
})();`;
const pagePatch = `${timePatch}
(() => {
  const patch = ${JSON.stringify(timePatch)};
  const NativeWorker = window.Worker;
  window.Worker = function (url, opts) {
    const abs = new URL(String(url), location.href).href;
    const patchUrl = URL.createObjectURL(new Blob([patch], { type: "text/javascript" }));
    const src = opts && opts.type === "module"
      ? "import " + JSON.stringify(patchUrl) + ";\\nimport " + JSON.stringify(abs) + ";"
      : patch + "\\nimportScripts(" + JSON.stringify(abs) + ");";
    return new NativeWorker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), opts);
  };
})();`;

/** Real milliseconds for `ms` of page time. */
const real = (ms: number) => ms / SLOW;

const browser = await chromium.launch({
  // For a machine whose Chromium is not the one Playwright downloaded.
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
await mkdir(OUT_DIR, { recursive: true });
const frameDir = await mkdtemp(join(tmpdir(), "stapes-hero-"));
try {
  const context = await browser.newContext({
    viewport: { width: 1000 + VIEW_PX * SCALE, height: VIEW_PX * SCALE + CHAT_BAR_PX },
  });
  await context.addInitScript({ content: pagePatch });
  const page = await context.newPage();

  const signIn = await page.request.post(new URL("/api/auth/sign-in/username", base).href, {
    data: ADMIN,
  });
  if (!signIn.ok()) throw new Error(`signing in failed: ${signIn.status()}`);
  await page.goto(new URL("/admin/play", base).href, { waitUntil: "load", timeout: real(60_000) });
  await page
    .locator('[data-world-status="live"]')
    .waitFor({ state: "attached", timeout: real(60_000) });
  await page.waitForTimeout(real(2000));

  const chat = page.getByPlaceholder("Say something");
  for (const command of [`/time ${TIME}`, START]) {
    await chat.fill(command);
    await chat.press("Enter");
    await page.waitForTimeout(real(500));
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.addStyleTag({ content: ".world-label-layer { visibility: hidden !important; }" });
  // Out of the canvas, so nothing under the pointer is outlined.
  await page.mouse.move(1, 1);
  // Long enough for the chunks around the new position to be built and lit.
  await page.waitForTimeout(real(5000));

  const box = await page.locator("canvas").first().boundingBox();
  if (!box || box.width !== VIEW_PX * SCALE || box.height !== VIEW_PX * SCALE) {
    throw new Error(`the canvas is ${box?.width}x${box?.height}, not ${VIEW_PX * SCALE} square`);
  }

  const cdp = await context.newCDPSession(page);
  const frames: { file: string; at: number }[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    const file = join(frameDir, `${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 });
    void writeFile(file, Buffer.from(frame.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 100 });
  for (const [key, ms] of ROUTE) {
    if (key) await page.keyboard.down(key);
    await page.waitForTimeout(real(ms));
    if (key) await page.keyboard.up(key);
  }
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(500);

  const seconds = (frames.at(-1)!.at - frames[0]!.at) * SLOW;
  console.log(`${frames.length} frames over ${seconds.toFixed(1)}s of page time`);
  if (frames.length / seconds < FPS * 0.8) {
    console.warn(
      `only ${(frames.length / seconds).toFixed(1)} fps: lower SLOW for a smoother video`,
    );
  }

  // Each frame is shown for as long as it was on screen, in page time; ffmpeg
  // then resamples that to a constant rate.
  const list = frames
    .map((frame, i) => {
      const next = frames[i + 1]?.at ?? frame.at + 1 / FPS / SLOW;
      return `file '${frame.file}'\nduration ${((next - frame.at) * SLOW).toFixed(4)}`;
    })
    .join("\n");
  const listFile = join(frameDir, "frames.txt");
  await writeFile(listFile, `ffconcat version 1.0\n${list}\n`);

  const crop = `crop=${box.width}:${box.height}:${box.x}:${box.y}`;
  const upscale = `scale=iw*2:ih*2:flags=neighbor`;
  const ffmpeg = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const run = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
      run.on("error", reject);
      run.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg ${args.join(" ")} failed`)),
      );
    });
  const frameInput = ["-f", "concat", "-safe", "0", "-i", listFile];
  const video = ["-vf", `${crop},${upscale},fps=${FPS}`, "-an"];
  // Two encodings of the same frames. Every current browser plays the H.264
  // one; the VP9 one is for an open-source Chromium, which has no H.264
  // decoder — Playwright's is one, so it is what the page is checked with.
  await ffmpeg([
    ...frameInput,
    ...video,
    ..."-c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart".split(" "),
    join(OUT_DIR, "hero.mp4"),
  ]);
  await ffmpeg([
    ...frameInput,
    ...video,
    ..."-c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -pix_fmt yuv420p".split(" "),
    join(OUT_DIR, "hero.webm"),
  ]);
  await ffmpeg([
    "-i",
    frames[0]!.file,
    "-vf",
    `${crop},${upscale}`,
    "-q:v",
    "3",
    join(OUT_DIR, "hero.jpg"),
  ]);
  console.log(`wrote hero.webm, hero.mp4 and hero.jpg to ${OUT_DIR}`);
} finally {
  await browser.close();
  await rm(frameDir, { recursive: true, force: true });
}
