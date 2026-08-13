import { expect, test } from "@playwright/test";
import { PERF_BUDGETS } from "../app/editor/perf";

/**
 * Structure caps always run. Frame-time budget:
 * - Local → p95 < 1ms
 * - CI → p95 < 8ms (shared runners / software GL)
 * - PERF_SKIP_TIMING=1 → skip timing, keep structure asserts
 */
function frameMsBudget(): number | null {
  if (process.env.PERF_SKIP_TIMING === "1") return null;
  if (process.env.CI) return PERF_BUDGETS.frameMsP95Ci;
  return PERF_BUDGETS.frameMsP95;
}

/**
 * How long the app is allowed to take to exist, as opposed to to draw.
 *
 * None of this is a budget — the budgets are the assertions at the bottom, and
 * they only measure frames taken after `ready()` resolves. Everything before
 * that is the app booting, and on a cold Vite cache most of it is the module
 * graph being transformed for the first time: a fresh clone, CI, the first run
 * after touching a source file, or simply another dev server compiling on the
 * same machine.
 *
 * These were 15s and 30s, which a cold compile beats on a quiet laptop and
 * loses to badly under any contention. That failed the run on a timeout, which
 * reads as a renderer regression and is nothing of the sort. Generous here
 * costs a slow failure on a genuinely broken app and buys a test that only
 * fails for the reason it exists.
 */
const BOOT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;

test.describe("editor renderer perf", () => {
  test("stays within draw-call / mesh / frame budgets", async ({ page }) => {
    // Room for the boot allowances above, on top of the config's own budget.
    test.setTimeout(BOOT_TIMEOUT_MS + READY_TIMEOUT_MS + 60_000);

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto("/map", { waitUntil: "networkidle" });
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });

    await page.waitForFunction(() => window.__editorPerf != null, null, {
      timeout: BOOT_TIMEOUT_MS,
    });
    await page.waitForFunction(() => window.__editorPerf?.ready() === true, null, {
      timeout: READY_TIMEOUT_MS,
    });

    expect(pageErrors, `page errors: ${pageErrors.join("\n")}`).toEqual([]);

    const result = await page.evaluate((samples) => {
      return window.__editorPerf!.measureRenders(samples);
    }, 60);

    expect(
      result.placedQuads,
      "fixture map should have enough quads to make this a real budget",
    ).toBeGreaterThan(500);

    expect(
      result.calls,
      `draw calls ${result.calls} exceeded budget ${PERF_BUDGETS.maxDrawCalls}`,
    ).toBeLessThanOrEqual(PERF_BUDGETS.maxDrawCalls);

    expect(
      result.triangles,
      `triangles ${result.triangles} exceeded budget ${PERF_BUDGETS.maxTriangles}`,
    ).toBeLessThanOrEqual(PERF_BUDGETS.maxTriangles);

    expect(
      result.worldMeshes,
      `world meshes ${result.worldMeshes} exceeded budget ${PERF_BUDGETS.maxWorldMeshes}`,
    ).toBeLessThanOrEqual(PERF_BUDGETS.maxWorldMeshes);

    expect(
      result.worldMeshes / result.placedQuads,
      `mesh/quad ratio ${result.worldMeshes}/${result.placedQuads} — merged path regressed?`,
    ).toBeLessThanOrEqual(PERF_BUDGETS.maxMeshToQuadRatio);

    const msLimit = frameMsBudget();
    if (msLimit !== null) {
      expect(
        result.p95Ms,
        `p95 frame ${result.p95Ms.toFixed(3)}ms exceeded ${msLimit}ms ` +
          `(p50=${result.p50Ms.toFixed(3)} max=${result.maxMs.toFixed(3)}; ` +
          `set PERF_SKIP_TIMING=1 to skip timing)`,
      ).toBeLessThanOrEqual(msLimit);
    }
  });
});
