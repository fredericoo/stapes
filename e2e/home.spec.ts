import { expect, test } from "@playwright/test";

test.describe("the landing page", () => {
  test("hydrates without an error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    /**
     * A cold dev server optimises its dependencies on the first load and
     * reloads the page, logging errors that have nothing to do with the page.
     */
    await page.goto("/", { waitUntil: "networkidle" });
    errors.length = 0;

    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator("#features")).toHaveAttribute("style", /--home-reading-top/);

    expect(errors).toEqual([]);
  });

  test("pages through the pictures and closes onto the one it ended on", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const pictures = page.getByRole("region", { name: "Pictures" });
    const lightbox = page.getByRole("dialog", { name: "Pictures" });
    const inn = pictures.getByRole("button", { name: "Inside the Gilded Barrel at midday." });
    const cast = pictures.getByRole("button", { name: /^Casting Pyre at a wolf/ });

    await inn.click();
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByText("Inside the Gilded Barrel at midday.")).toBeVisible();
    await expect(lightbox.getByRole("button", { name: "Close" })).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(lightbox.getByText(/^Casting Pyre at a wolf/)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(cast).toBeFocused();
  });
});
