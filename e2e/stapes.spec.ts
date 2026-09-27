import { expect, test } from "@playwright/test";
import { signInAsAdmin } from "./accounts";

const BOOT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;

const NEIGHBOURS = ["+1 +0", "-1 +0", "+0 +1", "+0 -1"];

/**
 * The part of `window.__stapes` this spec calls, written out here because the
 * page's own type imports the renderer, which the Node tsconfig cannot check.
 */
type Stapes = {
  ready(options?: { timeoutMs?: number }): Promise<void>;
  command(text: string): Promise<{ ok: boolean; ids?: string[]; refusal?: { kind: string } }>;
  snapshot(): { selfId: string; bodies: { id: string; tileId: string; hp: number | null }[] };
  events(since?: number): Record<string, unknown>[];
  act(input: { target: string } | { attackMode: boolean }): boolean;
};

declare global {
  interface Window {
    __stapes?: Stapes;
  }
}

test.describe("window.__stapes", () => {
  test("sets up a scene, reads it back and reports what happened, with no UI", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + READY_TIMEOUT_MS + 60_000);

    await signInAsAdmin(page);
    await page.goto("/admin/play", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__stapes != null, null, {
      timeout: BOOT_TIMEOUT_MS,
    });
    await page.evaluate((timeoutMs) => window.__stapes!.ready({ timeoutMs }), READY_TIMEOUT_MS);

    const summoned = await page.evaluate(async (cells) => {
      for (const cell of cells) {
        const reply = await window.__stapes!.command(`/tile rat ${cell}`);
        if (reply.ok) return reply;
      }
      return null;
    }, NEIGHBOURS);
    expect(summoned, "no free cell beside the spawn for a rat").not.toBeNull();
    expect(summoned!.ids).toHaveLength(1);
    const ratId = summoned!.ids![0]!;

    const snapshot = await page.evaluate(() => window.__stapes!.snapshot());
    expect(snapshot.bodies.find((body) => body.id === ratId)).toMatchObject({
      tileId: "rat",
      hp: expect.any(Number),
    });

    const refused = await page.evaluate(() => window.__stapes!.command("/tile nothing"));
    expect(refused).toMatchObject({ ok: false, refusal: { kind: "unknownTile" } });

    await page.evaluate(() => window.__stapes!.command("/health -3"));
    const events = await page.evaluate(() => window.__stapes!.events());
    expect(events).toContainEqual(expect.objectContaining({ kind: "spawned", actorId: ratId }));
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "damage", targetId: snapshot.selfId, amount: 3 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "notice", text: expect.stringMatching(/^Rat appears at/) }),
    );

    await page.evaluate((target) => {
      window.__stapes!.act({ target });
      window.__stapes!.act({ attackMode: true });
    }, ratId);
    await page.waitForFunction(
      ({ selfId }) =>
        window
          .__stapes!.events()
          .some((event) => event.kind === "swung" && event.actorId === selfId),
      { selfId: snapshot.selfId },
      { timeout: 10_000, polling: 100 },
    );
  });
});
