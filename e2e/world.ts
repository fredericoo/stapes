import type { Locator, Page } from "@playwright/test";

/**
 * The world page once its connection is live.
 *
 * Waited on rather than the canvas, which is mounted as soon as the world route
 * is and well before `hello` — so a message typed against it is one the world
 * never hears. An attribute rather than the "live" chip, because the chip is in
 * the game's menu and the menu is closed.
 */
export function liveWorld(page: Page): Locator {
  return page.locator('[data-world-status="live"]');
}

/** Open the game's menu, behind the cog, unless it is open already. */
export async function openGameMenu(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "Menu" });
  if ((await menu.getAttribute("data-popup-open")) !== null) return;
  await menu.click();
}
