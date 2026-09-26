import { expect, test } from "@playwright/test";
import { PERF_BUDGETS } from "../app/editor/perf";
import { signInAsAdmin } from "./accounts";

function frameMsBudget(): number | null {
  if (process.env.PERF_SKIP_TIMING === "1") return null;
  if (process.env.CI) return PERF_BUDGETS.frameMsP95Ci;
  return PERF_BUDGETS.frameMsP95;
}

const BOOT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;

test.describe("editor renderer perf", () => {
  test("stays within draw-call / mesh / frame budgets", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + READY_TIMEOUT_MS + 60_000);

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await signInAsAdmin(page);

    await page.goto("/admin/map", { waitUntil: "networkidle" });
    await page.locator("canvas").first().waitFor({ timeout: BOOT_TIMEOUT_MS });
    pageErrors.length = 0;

    await page.goto("/admin/map", { waitUntil: "networkidle" });
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
      "the authored map should have enough quads to make this a real budget",
    ).toBeGreaterThan(500);

    expect(
      result.calls,
      `draw calls ${result.calls} exceeded budget ${PERF_BUDGETS.maxDrawCalls}`,
    ).toBeLessThanOrEqual(PERF_BUDGETS.maxDrawCalls);

    const triangleBudget = Math.round(result.placedQuads * PERF_BUDGETS.maxTrianglesPerQuad);
    const perQuad = result.triangles / result.placedQuads;

    expect(
      result.triangles,
      `triangles ${result.triangles} exceeded ${triangleBudget} — ` +
        `${perQuad.toFixed(2)} per quad over ${result.placedQuads} quads, ` +
        `against a ceiling of ${PERF_BUDGETS.maxTrianglesPerQuad}. ` +
        `The map cannot cause this: the budget is a multiple of the map. ` +
        `Something is drawing extra geometry per tile — an unmerged overlay, ` +
        `a second pass, a ghost drawn solid.`,
    ).toBeLessThanOrEqual(triangleBudget);

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
