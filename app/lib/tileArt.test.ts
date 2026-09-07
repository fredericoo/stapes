import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { getFrames } from "./tileResolve";
import { normalizeTiles, type Direction, type TileDef } from "./types";

/**
 * What the shipped catalogue's walk art has to hold to, asked of the real
 * catalogue because that is the thing being claimed about — see the note in
 * `CLAUDE.md` on why `data/tiles.json` stays real while `data/map.json` does
 * not. A fixture creature with invented rects would test the fixture.
 */

const authored = normalizeTiles(tilesJson as never);
const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

/** The tiles that animate a walk, which is the only population this is about. */
function walkers(): TileDef[] {
  return authored.filter((def) => def.states?.moving?.sprites != null);
}

function walkCycle(def: TileDef, direction: Direction): string {
  return JSON.stringify(
    getFrames(def, { state: "moving", direction })?.map((f) => f.sprite) ?? [],
  );
}

/**
 * Two facings of one walk cycle drawn from the same frames.
 *
 * Symmetric scenery reuses art on purpose — a sign, a roof and an anvil all
 * draw north and south from one rect, and there is nothing to tell apart. A
 * body is the opposite case: it has a front, so a repeated facing is always a
 * row somebody copied and forgot to move. The rabbit ran north in its
 * west-facing frames for as long as this went unasked, which read as a rabbit
 * bolting away from you with its head turned to watch you.
 */
describe("the walk art in data/tiles.json", () => {
  it("has a population to be about", () => {
    expect(walkers().length).toBeGreaterThan(4);
  });

  it.each(walkers().map((def) => [def.id, def] as const))(
    "draws every facing of %s's walk differently",
    (_id, def) => {
      const drawnBy = new Map<string, Direction>();
      for (const direction of DIRECTIONS) {
        const cycle = walkCycle(def, direction);
        const twin = drawnBy.get(cycle);
        expect(
          twin,
          `walks ${direction} in the frames it walks ${twin} in`,
        ).toBeUndefined();
        drawnBy.set(cycle, direction);
      }
    },
  );
});
