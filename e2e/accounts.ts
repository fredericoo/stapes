import { expect, type Page } from "@playwright/test";

/**
 * The seeded administrator, which is the only account a fresh world has.
 *
 * Written down here as well as in `server/auth.ts` deliberately: a test that
 * imported the constant would still pass if somebody changed the seed and
 * forgot the deployment that is already running on the old one. @see
 * `server/auth.ts`'s `seedAdmin`
 */
export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "salem123";

/**
 * Put an administrator's session cookie in this browser, without a form.
 *
 * The editors are behind `ADMIN` now, so every test that opens one has to get
 * in first — and typing into the door is not what those tests are about. The
 * request shares the page's cookie jar, so what follows is an ordinary
 * navigation as somebody signed in.
 *
 * `e2e/session.spec.ts`'s walk through the doors deliberately does *not* use
 * this: the door is what that test is a claim about, so it presses the buttons.
 * The mid-fight test in the same file does, because it is not about the door —
 * it is about a button that only appears once you are through one.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/sign-in/username", {
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(
    response.ok(),
    `signing in as ${ADMIN_USERNAME} failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

/**
 * A name nothing else in the suite will take.
 *
 * Character names are unique for the life of the world and can never be
 * changed, so a test that creates one can only be run once against a given
 * database — unless the name it types is different every time. The run's clock
 * is enough: the suite is serial, and two runs a millisecond apart is not a
 * thing that happens.
 */
export function freshCharacterName(prefix = "Tester"): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let n = Date.now(); suffix.length < 6; n = Math.floor(n / 26)) {
    suffix += letters[n % 26];
  }
  return `${prefix}${suffix}`;
}
