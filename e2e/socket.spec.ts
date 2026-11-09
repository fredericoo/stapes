import { expect, test } from "@playwright/test";
import { freshCharacterName } from "./accounts";
import { liveWorld } from "./world";

const BOOT_TIMEOUT_MS = 120_000;
const WALK_STEPS = 6;
const STEP_HOLD_MS = 400;
const SETTLE_MS = 3_000;
const MIN_FRAMES_AFTER_HELLO = 5;

type GameSocket = { closed: boolean; hellos: number; framesAfterHello: number };

/**
 * Safari once dropped the connection a moment after its `hello`, at once if
 * the player walked, because of how the server compressed what followed. This
 * walks a guest about and asks that the socket it joined on is still open and
 * still being sent the world.
 */
test.describe("the game socket", () => {
  test("stays open after the hello while a guest walks about", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);

    const sockets: GameSocket[] = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws?")) return;
      const socket: GameSocket = { closed: false, hellos: 0, framesAfterHello: 0 };
      sockets.push(socket);
      ws.on("close", () => {
        socket.closed = true;
      });
      ws.on("framereceived", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString();
        if (text.startsWith('{"type":"hello"')) socket.hellos++;
        else if (socket.hellos > 0) socket.framesAfterHello++;
      });
    });

    await page.goto("/sign-in", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Play as a guest" }).click();
    await page.waitForURL((url) => url.pathname === "/guest", { timeout: 30_000 });
    await page.getByLabel("Name").fill(`${freshCharacterName("Walker")} Ormstead`);
    await page.getByRole("button", { name: "Play" }).click();
    const live = liveWorld(page);
    await expect(live).toBeAttached({ timeout: BOOT_TIMEOUT_MS });

    for (let step = 0; step < WALK_STEPS; step++) {
      const key = step % 2 === 0 ? "ArrowRight" : "ArrowLeft";
      await page.keyboard.down(key);
      await page.waitForTimeout(STEP_HOLD_MS);
      await page.keyboard.up(key);
    }
    await page.waitForTimeout(SETTLE_MS);

    const greeted = sockets.filter((socket) => socket.hellos > 0);
    expect(greeted).toHaveLength(1);
    expect(greeted[0]).toMatchObject({ closed: false, hellos: 1 });
    expect(greeted[0]!.framesAfterHello).toBeGreaterThanOrEqual(MIN_FRAMES_AFTER_HELLO);
    await expect(live).toBeAttached();
  });
});
