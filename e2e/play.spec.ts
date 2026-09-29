import { expect, test } from "@playwright/test";
import { signInAsAdmin } from "./accounts";
import { liveWorld, openGameMenu } from "./world";

const BOOT_TIMEOUT_MS = 120_000;

const ACTOR_STORAGE_KEY = "stapes:local-actor";

test.describe("the world in the tab", () => {
  test("plays with no server behind it, and remembers you", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);

    const gameSockets: string[] = [];
    page.on("websocket", (ws) => {
      if (ws.url().includes("/ws?")) gameSockets.push(ws.url());
    });

    const actor = () => page.evaluate((key) => localStorage.getItem(key), ACTOR_STORAGE_KEY);

    await signInAsAdmin(page);
    await page.goto("/admin/play", { waitUntil: "networkidle" });

    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(liveWorld(page)).toBeAttached({
      timeout: 60_000,
    });

    expect(gameSockets).toEqual([]);

    const first = await actor();
    expect(first).toBeTruthy();

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(liveWorld(page)).toBeAttached({
      timeout: 60_000,
    });
    expect(await actor()).toBe(first);
    expect(gameSockets).toEqual([]);

    const say = page.getByPlaceholder("Say something");
    await say.fill("/health -3");
    await say.press("Enter");
    await expect(page.getByRole("img", { name: /^In combat\./ })).toBeVisible({
      timeout: 30_000,
    });

    await openGameMenu(page);
    const reset = page.getByRole("button", { name: "Reset world" });
    await expect(reset).toBeVisible();
    await reset.click();
    await page.getByRole("button", { name: /Sure\?/ }).click();
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(liveWorld(page)).toBeAttached({
      timeout: 60_000,
    });

    await openGameMenu(page);
    await expect(page.getByRole("link", { name: "Map" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Leave world" })).toHaveCount(0);
  });
});
