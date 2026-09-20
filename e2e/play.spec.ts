import { expect, test } from "@playwright/test";

/**
 * `/admin/play`, which is the same game with the world in the tab.
 *
 * This is the claim the route exists to make, and it is a claim about the
 * shipped app rather than about a module — that the page comes up, lets
 * somebody in, and paints a world **without a socket to anything**. Nothing
 * here reads `data/map.json`: what it asserts is that a canvas appears, that no
 * game socket is opened, and that an identity survives a reload, none of which
 * an afternoon's authoring can move.
 *
 * It is also the path the rest of the suite is meant to lean on as `/` grows a
 * login: a world you can get into with no account and no server is the one
 * place a change to the game can be seen working.
 */

/** The app booting on a cold Vite cache. @see ./renderer-perf.spec.ts */
const BOOT_TIMEOUT_MS = 120_000;

/** Where the local world keeps who you are. @see app/local/link.ts */
const ACTOR_STORAGE_KEY = "stapes:local-actor";

test.describe("the world in the tab", () => {
  test("plays with no server behind it, and remembers you", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);

    const gameSockets: string[] = [];
    page.on("websocket", (ws) => {
      // Vite's own hot-reload socket is on this origin too, and is not the game.
      if (ws.url().includes("/ws?")) gameSockets.push(ws.url());
    });

    const actor = () =>
      page.evaluate((key) => localStorage.getItem(key), ACTOR_STORAGE_KEY);

    await page.goto("/admin/play", { waitUntil: "networkidle" });

    const logIn = page.getByRole("button", { name: "Log in", exact: true });
    await expect(logIn).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    // The same door the game has, and it means the same thing: nothing is
    // simulating anybody who has not asked to be here.
    expect(await actor()).toBeNull();

    await logIn.click();
    await expect(page.getByRole("button", { name: /Logging in/ })).toHaveCount(
      0,
      { timeout: BOOT_TIMEOUT_MS },
    );
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.getByText("live", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });

    // **The whole point.** A world on screen, a headcount, and not one frame of
    // it over a socket.
    expect(gameSockets).toEqual([]);

    const first = await actor();
    expect(first).toBeTruthy();

    // A reload is a reconnect to a world that was written down, so it goes
    // straight back in — no door, and the same body.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(page.getByText("live", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    expect(await actor()).toBe(first);
    expect(gameSockets).toEqual([]);

    // A command, which is the sharpest thing to ask of this route: it is typed
    // into the chat field, it reaches a world, and what comes back is the
    // vitals that world pushed. The page that used to be here could not do any
    // of it, because there was nothing to send to.
    const say = page.getByPlaceholder("Say something");
    await say.fill("/health -3");
    await say.press("Enter");
    await expect(page.getByRole("img", { name: /^In combat\./ })).toBeVisible({
      timeout: 30_000,
    });

    // And the way back to a known world, which is the control the shared world
    // keeps behind `ADMIN_SECRET` because it is everybody's.
    const reset = page.getByRole("button", { name: "Reset world" });
    await expect(reset).toBeVisible();
    await reset.click();
    await page.getByRole("button", { name: /Sure\?/ }).click();
    // The world is replaced under the socket rather than closing it: the page
    // redraws from a fresh `hello` and never leaves `live`.
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.getByText("live", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });

    // Unlike the game, this page is an authoring page and says so.
    await expect(page.locator("header nav a").first()).toBeVisible();
  });
});
