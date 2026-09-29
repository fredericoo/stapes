import { expect, type Page } from "@playwright/test";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "salem123";

export async function signInAsAdmin(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/sign-in/username", {
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(
    response.ok(),
    `signing in as ${ADMIN_USERNAME} failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

export function freshCharacterName(prefix = "Tester"): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let n = Date.now(); suffix.length < 6; n = Math.floor(n / 26)) {
    suffix += letters[n % 26];
  }
  return `${prefix}${suffix}`;
}
