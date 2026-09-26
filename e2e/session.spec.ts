import { expect, test, type Page } from "@playwright/test";
import { ADMIN_USERNAME, freshCharacterName, signInAsAdmin } from "./accounts";
import { liveWorld, openGameMenu } from "./world";

const BOOT_TIMEOUT_MS = 120_000;

test.describe("the way in", () => {
  test("is a route per question, and keeps the account when a character leaves", async ({
    page,
  }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 180_000);

    const gameSockets: { url: string; closed: boolean }[] = [];
    page.on("websocket", (ws) => {
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
    const landsOn = async (path: string) => {
      await page.waitForURL((url) => url.pathname === path, {
        timeout: 30_000,
      });
    };
    const live = liveWorld(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByLabel("Username").waitFor({ timeout: BOOT_TIMEOUT_MS });
    await landsOn("/sign-in");
    expect(gameSockets).toEqual([]);

    for (const guarded of ["/characters", "/characters/new", "/account/password"]) {
      await page.goto(guarded, { waitUntil: "networkidle" });
      await landsOn("/sign-in");
    }

    await page.getByRole("link", { name: "Create an account" }).click();
    await landsOn("/sign-up");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Email").fill(`${username}@example.test`);
    await page.getByLabel("Password").fill("a-long-enough-password");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible({
      timeout: 30_000,
    });
    await landsOn("/characters");
    expect(gameSockets).toEqual([]);

    await page.getByRole("link", { name: "New character" }).click();
    await landsOn("/characters/new");
    await page.getByLabel("Name").fill("Ka1n");
    await expect(page.getByRole("button", { name: "Create and enter" })).toBeDisabled();
    await page.getByLabel("Name").fill(character);
    await page.getByRole("button", { name: "Create and enter" }).click();

    await expect(live).toBeAttached({ timeout: BOOT_TIMEOUT_MS });
    await landsOn("/");
    await expect.poll(() => openSockets().length, { timeout: 30_000 }).toBe(1);
    expect(openSockets()[0]!.url).toContain("character=");

    await expect(page.locator("header nav a")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Change password" })).toHaveCount(0);

    await pressLeaveWorld(page);
    await expect(page.getByRole("button", { name: character })).toBeVisible({
      timeout: 30_000,
    });
    await landsOn("/characters");
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect.poll(() => openSockets().length, { timeout: 30_000 }).toBe(0);
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();

    await page.getByRole("link", { name: "Change password" }).click();
    await landsOn("/account/password");
    await page.getByLabel("Current password").fill("a-long-enough-password");
    await page.getByLabel("New password").fill("a-different-password");
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByRole("button", { name: "Back to characters" }).click();
    await landsOn("/characters");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Username").waitFor({ timeout: 30_000 });
    await landsOn("/sign-in");

    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill("a-different-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: character })).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("leaving mid-fight", () => {
  test("warns before a character walks out of a fight, and stays if told to", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);

    await enterWorldAsAdmin(page);

    const say = page.getByPlaceholder("Say something");
    await say.fill("/health -3");
    await say.press("Enter");
    await expect(page.getByRole("img", { name: /^In combat\./ })).toBeVisible({
      timeout: 30_000,
    });

    await pressLeaveWorld(page);
    const warning = page.getByRole("dialog", { name: "Leave mid-fight" });
    await expect(warning).toContainText("your body stays in the world", {
      timeout: 30_000,
    });

    await warning.getByRole("button", { name: "Stay" }).click();
    await expect(page.locator("canvas").first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    await pressLeaveWorld(page);
    await warning.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_USERNAME}`)).toBeVisible({
      timeout: 30_000,
    });
  });
});

async function pressLeaveWorld(page: Page): Promise<void> {
  await openGameMenu(page);
  await page.getByRole("button", { name: "Leave world" }).click();
}

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

  await expect(liveWorld(page)).toBeAttached({
    timeout: BOOT_TIMEOUT_MS,
  });
}

test.describe("the editors", () => {
  test("turns away a browser with no administrator behind it", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);

    await page.goto("/admin/map", { waitUntil: "networkidle" });
    await expect(page.getByText("Administrators only")).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    expect(new URL(page.url()).pathname).toBe("/admin/sign-in");
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);

    const refused = await page.request.get("/api/map");
    expect(refused.status()).toBe(404);
  });
});
