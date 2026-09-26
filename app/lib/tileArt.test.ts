import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { getFrames } from "./tileResolve";
import { normalizeTiles, type Direction, type TileDef } from "./types";

const authored = normalizeTiles(tilesJson as never);
const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

function walkers(): TileDef[] {
  return authored.filter((def) => def.states?.moving?.sprites != null);
}

function walkCycle(def: TileDef, direction: Direction): string {
  return JSON.stringify(getFrames(def, { state: "moving", direction })?.map((f) => f.sprite) ?? []);
}

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
        expect(twin, `walks ${direction} in the frames it walks ${twin} in`).toBeUndefined();
        drawnBy.set(cycle, direction);
      }
    },
  );
});
