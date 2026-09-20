import { expect, test } from "@playwright/test";
import { freshCharacterName } from "./accounts";

/**
 * The three screens every player meets, against a real world.
 *
 * This is a claim about the shipped app rather than about a module — that there
 * is no way into the world without an account, that a character is what the
 * socket is opened as, and that leaving a character is not signing out of the
 * account — so it belongs here and not in `vitest`. None of it reads
 * `data/map.json`: what it asserts is that a canvas appears and which screen is
 * on top of it, neither of which an afternoon's authoring can move.
 *
 * It makes its own account rather than using the seeded administrator, because
 * what it is describing is what an ordinary player does. The names are unique
 * per run for the reason {@link freshCharacterName} gives: a character name can
 * never be reused, so a fixed one would pass once and fail every time after.
 */

/** The app booting on a cold Vite cache. @see ./renderer-perf.spec.ts */
const BOOT_TIMEOUT_MS = 120_000;

test.describe("the front door", () => {
  test("connects nothing until a character is chosen, and keeps the account when one leaves", async ({
    page,
  }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 180_000);

    const gameSockets: string[] = [];
    page.on("websocket", (ws) => {
      // Vite's own hot-reload socket is on this origin too, and is not the game.
      if (ws.url().includes("/ws?")) gameSockets.push(ws.url());
    });

    const username = freshCharacterName("player").toLowerCase();
    const character = freshCharacterName();
    /**
     * The chip the header shows once the socket is up.
     *
     * Waited on rather than the canvas, and the difference matters: the canvas
     * is mounted as soon as a character is chosen, well before `hello` — so a
     * message typed against it is one the world never hears.
     */
    const live = page.getByText("live", { exact: true }).first();

    await page.goto("/", { waitUntil: "networkidle" });

    // ---- the account ------------------------------------------------------
    const createAccount = page.getByRole("button", {
      name: "Create an account",
    });
    await expect(createAccount).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    // The point of the screen: nobody is in the world, and no socket is open.
    expect(gameSockets).toEqual([]);

    await createAccount.click();
    await page.getByLabel("Username").fill(username);
    // Asked for once, here, and then only stored — nothing sends to it. Signing
    // in below never asks again. @see `server/auth.ts`
    await page.getByLabel("Email").fill(`${username}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill(
      "a-long-enough-password",
    );
    await page.getByRole("button", { name: "Create account" }).click();

    // ---- the character ----------------------------------------------------
    // Signing in ends in a question rather than a world, so the account screen
    // goes and the chooser arrives — and still nothing has connected.
    const newCharacter = page.getByLabel("New character");
    await expect(newCharacter).toBeVisible({ timeout: 30_000 });
    expect(gameSockets).toEqual([]);

    await newCharacter.fill(character);
    await page.getByRole("button", { name: "Create character" }).click();

    // ---- the world --------------------------------------------------------
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(live).toBeVisible({ timeout: 60_000 });
    expect(gameSockets).toHaveLength(1);
    // The body is named by what was typed, not by anything derived from an id.
    expect(gameSockets[0]).toContain("character=");

    // Nothing in the game offers a way into the editors.
    await expect(page.locator("header nav a")).toHaveCount(0);
    // And nothing in the game offers the account's own controls: you sign in
    // and out of an account, a character enters and leaves the world, and the
    // two are never on the same screen. @see ../app/components/ChangePassword
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Change password" }),
    ).toHaveCount(0);

    // ---- leaving the world, which is not signing out ----------------------
    // Nothing to confirm out of a fight: the press is the whole of it.
    await page.getByRole("button", { name: "Leave world" }).click();
    // Back at the chooser rather than at the account screen, with the character
    // that was just left on it. @see docs/notes.md, "Leaving the world is not
    // signing out"
    await expect(page.getByRole("button", { name: character })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();

    await page.getByRole("button", { name: character }).click();
    await expect(live).toBeVisible({ timeout: BOOT_TIMEOUT_MS });

    // ---- the one case that asks -------------------------------------------
    // Losing hit points to anything flags combat, `/health -n` included, which
    // is the only way to be in a fight here that does not depend on a creature
    // happening to be in reach.
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

    await warning.getByRole("button", { name: "Stay" }).click();
    await expect(page.locator("canvas").first()).toBeVisible();

    await page.getByRole("button", { name: "Leave world" }).click();
    await warning.getByRole("button", { name: "Leave", exact: true }).click();

    // ---- and signing out, which lives on the chooser and nowhere else -----
    await expect(page.getByRole("button", { name: character })).toBeVisible({
      timeout: 30_000,
    });
    // Both of the account's controls are here, and this is the only screen
    // either of them is on.
    await expect(
      page.getByRole("button", { name: "Change password" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("button", { name: "Create an account" }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

/**
 * The editors are a permission now, not just a place.
 *
 * A claim about the shipped app for the reason above: what it asserts is that
 * the door appears and the server refuses, and both of those are wiring that a
 * unit test would have to stub out entirely.
 */
test.describe("the editors", () => {
  test("turns away a browser with no administrator behind it", async ({
    page,
  }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);

    await page.goto("/admin/map", { waitUntil: "networkidle" });
    await expect(page.getByText("Administrators only")).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(page.locator("canvas")).toHaveCount(0);
    // No offer to make an account: a role is assigned in the database, so one
    // made here would be signed in and refused in the same breath.
    await expect(
      page.getByRole("button", { name: "Create an account" }),
    ).toHaveCount(0);

    // And the part that is not a courtesy: the page is only a page, so what
    // actually holds is that the server will not hand the map over.
    const refused = await page.request.get("/api/map");
    expect(refused.status()).toBe(404);
  });
});
