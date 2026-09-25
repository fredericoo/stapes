import { expect, test } from "@playwright/test";
import { liveWorld, openGameMenu } from "./world";

/**
 * `/play`, which is the same game with the world in the tab.
 *
 * This is the claim the route exists to make, and it is a claim about the
 * shipped app rather than about a module — that the page comes up and paints a
 * world **without a socket to anything, and without an account**. Nothing here
 * reads `data/map.json`: what it asserts is that a canvas appears, that no game
 * socket is opened, and that an identity survives a reload, none of which an
 * afternoon's authoring can move.
 *
 * It starts at the sign-in screen, signed out, because that is how a visitor
 * reaches it: the offline link under the account one.
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

    const actor = () => page.evaluate((key) => localStorage.getItem(key), ACTOR_STORAGE_KEY);

    // Signed out, from the front door, the way a visitor gets here.
    await page.goto("/sign-in", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Play offline" }).click({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(page).toHaveURL(/\/play$/, { timeout: BOOT_TIMEOUT_MS });

    // Straight into a world: there is nothing to sign in to here, and no
    // character to choose. The identity is minted as the world is opened.
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(liveWorld(page)).toBeAttached({
      timeout: 60_000,
    });

    // **The whole point.** A world on screen, a headcount, and not one frame of
    // it over a socket.
    expect(gameSockets).toEqual([]);

    const first = await actor();
    expect(first).toBeTruthy();

    // A reload is a reconnect to a world that was written down, so it goes
    // straight back in, as the same body.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(liveWorld(page)).toBeAttached({
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
    await openGameMenu(page);
    const reset = page.getByRole("button", { name: "Reset world" });
    await expect(reset).toBeVisible();
    await reset.click();
    await page.getByRole("button", { name: /Sure\?/ }).click();
    // The world is replaced under the socket rather than closing it: the page
    // redraws from a fresh `hello` and never leaves `live`.
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(liveWorld(page)).toBeAttached({
      timeout: 60_000,
    });

    // The menu points at the shared world, which is the game this is a look
    // at, and not at the editors: a visitor has no business there.
    await openGameMenu(page);
    await expect(page.getByRole("link", { name: "Play online" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Map" })).toHaveCount(0);
    // And unlike the game, there is nowhere to leave this world to: it is this
    // tab's, and closing the tab is the way out of it.
    await expect(page.getByRole("button", { name: "Leave world" })).toHaveCount(0);
  });
});
