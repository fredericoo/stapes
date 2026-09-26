import type { Locator, Page } from "@playwright/test";

export function liveWorld(page: Page): Locator {
  return page.locator('[data-world-status="live"]');
}

export async function openGameMenu(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "Menu" });
  if ((await menu.getAttribute("data-popup-open")) !== null) return;
  await menu.click();
}
