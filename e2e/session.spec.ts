import { expect, test } from "@playwright/test";
import { ACTOR_COOKIE } from "../app/net/protocol";

/**
 * The two screens every tester meets, against a real world.
 *
 * This is a claim about the shipped app rather than about a module — that the
 * door is shut until somebody opens it, that opening it is what puts a body in
 * the world, and that leaving takes the character out without taking the
 * account with it — so it belongs here and not in `vitest`. None of it reads
 * `data/map.json`: what it asserts is that a canvas appears and that a cookie
 * does or does not survive, neither of which an afternoon's authoring can move.
 */

/** The app booting on a cold Vite cache. @see ./renderer-perf.spec.ts */
const BOOT_TIMEOUT_MS = 120_000;

test.describe("the front door", () => {
  test("connects nothing until Log in, and keeps the actor through Log out", async ({
    page,
    context,
  }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);

    const gameSockets: string[] = [];
    page.on("websocket", (ws) => {
      // Vite's own hot-reload socket is on this origin too, and is not the game.
      if (ws.url().includes("/ws?")) gameSockets.push(ws.url());
    });

    const actor = async () =>
      (await context.cookies()).find((c) => c.name === ACTOR_COOKIE)?.value;

    await page.goto("/", { waitUntil: "networkidle" });

    const logIn = page.getByRole("button", { name: "Log in", exact: true });
    await expect(logIn).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    // The point of the screen: no socket, and nobody minted to open one with.
    expect(gameSockets).toEqual([]);
    expect(await actor()).toBeUndefined();

    await logIn.click();
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(page.getByText("live", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    expect(gameSockets).toHaveLength(1);
    const first = await actor();
    expect(first).toBeTruthy();

    // Nothing in the game offers a way into the editors.
    await expect(page.locator("header nav a")).toHaveCount(0);

    // Nothing to confirm out of a fight: the press is the whole of it.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(logIn).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("canvas")).toHaveCount(0);

    // The character left; the account did not. @see docs/notes.md, "Logging out
    // leaves the character, not the account"
    expect(await actor()).toBe(first);

    await logIn.click();
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    expect(await actor()).toBe(first);

    // And the one case that does ask. Losing hit points to anything flags
    // combat, `/health -n` included, which is the only way to be in a fight
    // here that does not depend on a creature happening to be in reach.
    const say = page.getByPlaceholder("Say something");
    await say.fill("/health -3");
    await say.press("Enter");
    // Waited for rather than slept past: the button reads the vitals the server
    // pushes, and the strip is those same vitals drawn. @see StatusStrip
    await expect(page.getByRole("img", { name: /^In combat\./ })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Log out" }).click();
    const warning = page.getByRole("dialog");
    await expect(warning).toContainText("your body stays in the world", {
      timeout: 30_000,
    });

    await warning.getByRole("button", { name: "Stay" }).click();
    await expect(page.locator("canvas").first()).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();
    await warning.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(logIn).toBeVisible({ timeout: 30_000 });
    expect(await actor()).toBe(first);
  });
});
