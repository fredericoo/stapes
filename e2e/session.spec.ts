import { expect, test, type Page } from "@playwright/test";
import { ADMIN_USERNAME, freshCharacterName, signInAsAdmin } from "./accounts";

/**
 * The screens a player meets, against a real world.
 *
 * This is a claim about the shipped app rather than about a module — that there
 * is no way into the world without an account and a character, that each screen
 * is its own route with its own redirect when a precondition is missing, and
 * that the account's vocabulary and the character's never appear together — so
 * it belongs here and not in `vitest`. None of it reads `data/map.json`: what it
 * asserts is which URL you land on and what is on it, neither of which an
 * afternoon's authoring can move.
 *
 * The walk through the doors makes its own account rather than using the seeded
 * administrator, because what it is describing is what an ordinary player does.
 * Only the mid-fight test below needs a role, and it says why. The names are
 * unique per run for the reason {@link freshCharacterName} gives: a character
 * name can never be reused, so a fixed one would pass once and fail every time
 * after.
 */

/** The app booting on a cold Vite cache. @see ./renderer-perf.spec.ts */
const BOOT_TIMEOUT_MS = 120_000;

test.describe("the way in", () => {
  test("is a route per question, and keeps the account when a character leaves", async ({
    page,
  }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 180_000);

    /**
     * Every game socket this tab has opened, and whether it is still open.
     *
     * **Counted live rather than cumulatively**, and the difference is not
     * pedantry: React Router's client entry wraps the app in `StrictMode`, so
     * in development React mounts an effect, tears it down and mounts it again
     * — which opens a socket, closes it, and opens another. That is StrictMode
     * doing its job (it proves the connecting effect cleans up after itself),
     * and production mounts once. A cumulative count would be asserting a
     * development artifact; what matters is that the tab ends up holding
     * exactly one connection.
     */
    const gameSockets: { url: string; closed: boolean }[] = [];
    page.on("websocket", (ws) => {
      // Vite's own hot-reload socket is on this origin too, and is not the game.
      if (!ws.url().includes("/ws?")) return;
      const socket = { url: ws.url(), closed: false };
      gameSockets.push(socket);
      ws.on("close", () => {
        socket.closed = true;
      });
    });
    const openSockets = () => gameSockets.filter((one) => !one.closed);

    const username = freshCharacterName("player").toLowerCase();
    const character = freshCharacterName();
    /**
     * Wait until the app has settled on this path, and fail saying so if it
     * does not.
     *
     * `waitForURL` rather than reading `page.url()`, because a client
     * navigation only commits once the target route's `clientLoader` has
     * resolved — and every route here has one. Reading the URL straight after
     * a press races that, and the race is won by whichever screen was already
     * on the page.
     */
    const landsOn = async (path: string) => {
      await page.waitForURL((url) => url.pathname === path, {
        timeout: 30_000,
      });
    };
    /**
     * The chip the header shows once the socket is up.
     *
     * Waited on rather than the canvas, and the difference matters: the canvas
     * is mounted as soon as the world route is, well before `hello` — so a
     * message typed against it is one the world never hears.
     */
    const live = page.getByText("live", { exact: true }).first();

    // ---- every door redirects to the one before it -------------------------
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByLabel("Username").waitFor({ timeout: BOOT_TIMEOUT_MS });
    await landsOn("/sign-in");
    // The point of the screen: nobody is in the world, and nothing has even
    // tried to connect.
    expect(gameSockets).toEqual([]);

    for (const guarded of ["/characters", "/characters/new", "/account/password"]) {
      await page.goto(guarded, { waitUntil: "networkidle" });
      await landsOn("/sign-in");
    }

    // ---- the account ------------------------------------------------------
    await page.getByRole("link", { name: "Create an account" }).click();
    await landsOn("/sign-up");
    await page.getByLabel("Username").fill(username);
    // Asked for once, here, and then only stored — nothing sends to it. Signing
    // in below never asks again. @see `server/auth.ts`
    await page.getByLabel("Email").fill(`${username}@example.test`);
    await page.getByLabel("Password").fill("a-long-enough-password");
    await page.getByRole("button", { name: "Create account" }).click();

    // ---- the chooser ------------------------------------------------------
    // Signing in ends in another question rather than a world, so it lands on
    // the chooser — and still nothing has connected.
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible({
      timeout: 30_000,
    });
    await landsOn("/characters");
    expect(gameSockets).toEqual([]);

    // ---- naming one, which is its own route -------------------------------
    await page.getByRole("link", { name: "New character" }).click();
    await landsOn("/characters/new");
    // Refused while somebody is still typing, not on the press.
    await page.getByLabel("Name").fill("Ka1n");
    await expect(page.getByRole("button", { name: "Create and enter" })).toBeDisabled();
    await page.getByLabel("Name").fill(character);
    await page.getByRole("button", { name: "Create and enter" }).click();

    // ---- the world --------------------------------------------------------
    await expect(live).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await landsOn("/");
    // One connection, once the StrictMode remount above has settled.
    await expect.poll(() => openSockets().length, { timeout: 30_000 }).toBe(1);
    // Opened as the character, not as anything derived from an id — and the
    // server checked that name against the session before seating a body.
    expect(openSockets()[0]!.url).toContain("character=");

    // Nothing in the game offers a way into the editors.
    await expect(page.locator("header nav a")).toHaveCount(0);
    // And nothing in the game offers the account's own controls: you sign in
    // and out of an account, a character enters and leaves the world, and the
    // two are never on the same screen. @see docs/notes.md
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Change password" })).toHaveCount(0);

    // ---- leaving the world, which is not signing out ----------------------
    // Nothing to confirm out of a fight: the press is the whole of it.
    await page.getByRole("button", { name: "Leave world" }).click();
    await expect(page.getByRole("button", { name: character })).toBeVisible({
      timeout: 30_000,
    });
    await landsOn("/characters");
    await expect(page.locator("canvas")).toHaveCount(0);
    // And the body went with it: leaving the world closes the connection.
    await expect.poll(() => openSockets().length, { timeout: 30_000 }).toBe(0);
    // Still the same account — leaving is not signing out.
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();

    // Leaving *mid-fight* is the one press that asks first, and it is its own
    // test below: getting into a fight on demand takes a command, and a
    // command is not this account's to run.

    // ---- the password, which is its own route too -------------------------
    await page.getByRole("link", { name: "Change password" }).click();
    await landsOn("/account/password");
    await page.getByLabel("Current password").fill("a-long-enough-password");
    await page.getByLabel("New password").fill("a-different-password");
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByRole("button", { name: "Back to characters" }).click();
    await landsOn("/characters");

    // ---- and signing out, which lives here and nowhere else ---------------
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Username").waitFor({ timeout: 30_000 });
    await landsOn("/sign-in");

    // The new password is the one that works, which is what makes the change
    // above a change rather than a screen that said so.
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill("a-different-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: character })).toBeVisible({
      timeout: 30_000,
    });
  });
});

/**
 * The one press in the game that asks before it does anything.
 *
 * **Its own test on its own account, because getting into a fight on demand
 * takes a command.** Losing hit points to anything flags combat and `/health
 * -n` is the only way to lose some that does not wait on a creature happening
 * to be in reach — and a command is something only an administrator may run,
 * so the player in the test above types one and is told no. Waiting for a
 * creature instead would make this a claim about what is authored at spawn,
 * which is the thing `data/map.json` moves every afternoon.
 * @see `docs/notes.md`, "A command is typed where speech goes"
 *
 * The role changes nothing else on the screen: `/` hands `WorldPage` no editor
 * destinations for anybody, which is what the test above asserts.
 */
test.describe("leaving mid-fight", () => {
  test("warns before a character walks out of a fight, and stays if told to", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);

    await enterWorldAsAdmin(page);

    const say = page.getByPlaceholder("Say something");
    await say.fill("/health -3");
    await say.press("Enter");
    // Waited for rather than slept past: the button reads the vitals the server
    // pushes, and the strip is those same vitals drawn. @see StatusStrip
    await expect(page.getByRole("img", { name: /^In combat\./ })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Leave world" }).click();
    const warning = page.getByRole("dialog");
    await expect(warning).toContainText("your body stays in the world", {
      timeout: 30_000,
    });

    // Staying is staying: the same world, still on the world's own route.
    await warning.getByRole("button", { name: "Stay" }).click();
    await expect(page.locator("canvas").first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    await page.getByRole("button", { name: "Leave world" }).click();
    await warning.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_USERNAME}`)).toBeVisible({
      timeout: 30_000,
    });
  });
});

/**
 * Sign in as the seeded administrator and put one of its characters in the world.
 *
 * The cookie rather than the form, because the door is what the test above is a
 * claim about and this one is not.
 *
 * **It reuses a character before it makes one.** An account holds three and a
 * name can never be taken twice, so a helper that always created one would work
 * for three runs against a given database and fail on the fourth — which CI,
 * starting from an empty world every time, would never have said. The rows on
 * the chooser are the characters; everything else on that screen is a link.
 */
async function enterWorldAsAdmin(page: Page): Promise<void> {
  await signInAsAdmin(page);
  await page.goto("/characters", { waitUntil: "networkidle" });
  await expect(page.getByText(`Signed in as ${ADMIN_USERNAME}`)).toBeVisible({
    timeout: BOOT_TIMEOUT_MS,
  });

  const characters = page.locator("ul li button");
  if ((await characters.count()) > 0) {
    await characters.first().click();
  } else {
    await page.getByRole("link", { name: "New character" }).click();
    await page.getByLabel("Name").fill(freshCharacterName("Admin"));
    await page.getByRole("button", { name: "Create and enter" }).click();
  }

  // The chip, not the canvas: the canvas is mounted as soon as the world route
  // is, well before `hello`, so a command typed against it is one the world
  // never hears.
  await expect(page.getByText("live", { exact: true }).first()).toBeVisible({
    timeout: BOOT_TIMEOUT_MS,
  });
}

/**
 * The editors are a permission now, not just a place.
 *
 * A claim about the shipped app for the reason above: what it asserts is that
 * the door appears and the server refuses, and both of those are wiring that a
 * unit test would have to stub out entirely.
 */
test.describe("the editors", () => {
  test("turns away a browser with no administrator behind it", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);

    await page.goto("/admin/map", { waitUntil: "networkidle" });
    await expect(page.getByText("Administrators only")).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    expect(new URL(page.url()).pathname).toBe("/admin/sign-in");
    await expect(page.locator("canvas")).toHaveCount(0);
    // No offer to make an account: a role is assigned in the database, so one
    // made here would be signed in and refused in the same breath.
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);

    // And the part that is not a courtesy: the page is only a page, so what
    // actually holds is that the server will not hand the map over.
    const refused = await page.request.get("/api/map");
    expect(refused.status()).toBe(404);
  });
});
