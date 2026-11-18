import { expect, test, type Locator } from "@playwright/test";
import { signInAsAdmin } from "./accounts";
import { liveWorld, openGameMenu } from "./world";

const BOOT_TIMEOUT_MS = 120_000;

test.describe("the game on a phone", () => {
  test.use({ viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true });

  test("puts the joystick on the side the menu names, and remembers it", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);

    const joystick = page.getByRole("button", { name: "Walk north" });
    const list = page.getByRole("log", { name: "Within reach" });
    const joystickSide = async () => {
      const [pad, reach] = [await centerX(joystick), await centerX(list)];
      if (pad === null || reach === null) return null;
      return pad < reach ? "left" : "right";
    };

    await signInAsAdmin(page);
    await page.goto("/admin/play", { waitUntil: "networkidle" });
    await expect(liveWorld(page)).toBeAttached({ timeout: BOOT_TIMEOUT_MS });
    await expect.poll(joystickSide, { timeout: 60_000 }).toBe("right");

    await openGameMenu(page);
    await page
      .getByRole("group", { name: "Joystick" })
      .getByRole("button", { name: "Left" })
      .click();
    await expect.poll(joystickSide).toBe("left");

    await page.reload({ waitUntil: "networkidle" });
    await expect(liveWorld(page)).toBeAttached({ timeout: BOOT_TIMEOUT_MS });
    await expect.poll(joystickSide, { timeout: 60_000 }).toBe("left");
  });

  test("keeps drawing the board after the phone turns sideways and back", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);
    const board = page.locator("canvas:has(+ .world-label-layer)");
    const buffer = () => board.evaluate((c: HTMLCanvasElement) => `${c.width}x${c.height}`);

    await signInAsAdmin(page);
    await page.goto("/admin/play", { waitUntil: "networkidle" });
    await expect(liveWorld(page)).toBeAttached({ timeout: BOOT_TIMEOUT_MS });
    await board.evaluate((c) => c.setAttribute("data-first-board", ""));
    const drawn = await buffer();

    await page.setViewportSize({ width: 839, height: 412 });
    await expect(page.locator("canvas[data-first-board]")).toBeAttached();
    await expect.poll(buffer).toBe(drawn);

    await page.setViewportSize({ width: 412, height: 839 });
    await expect(page.locator("canvas[data-first-board]")).toBeAttached();
    await expect.poll(buffer).toBe(drawn);
  });
});

async function centerX(locator: Locator): Promise<number | null> {
  const box = await locator.boundingBox();
  return box ? box.x + box.width / 2 : null;
}
