import { describe, expect, it } from "vitest";
import { chunkKeyFor, emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { levelKey } from "../lib/types";
import { withClaimedRewards } from "./claimedRewards";

const FAR_CELL = 200;

function catalogue(claimedTileId: string): Record<string, TileDef> {
  const chest = { id: "chest", interactions: { reward: { claimedTileId } } } as unknown as TileDef;
  const open = { id: "chest-open" } as unknown as TileDef;
  return { chest, "chest-open": open };
}

function chest(rewardTag: string): PlacedTile {
  return { tileId: "chest", rewardTag, rewardTileIds: ["sword"] } as PlacedTile;
}

function world(): MapFile {
  const near = replaceStack(emptyMap(), 0, 0, 0, [chest("first")]);
  const both = replaceStack(near, 1, 0, 0, [chest("second")]);
  return replaceStack(both, FAR_CELL, FAR_CELL, 0, [chest("second")]);
}

describe("withClaimedRewards", () => {
  it("draws only the chests whose tag the viewer holds as their claimed tile", () => {
    const drawn = withClaimedRewards(world(), catalogue("chest-open"), ["first"]);

    expect(getStack(drawn, 0, 0, 0)[0]?.tileId).toBe("chest-open");
    expect(getStack(drawn, 1, 0, 0)[0]?.tileId).toBe("chest");
  });

  it("keeps the identity of every chunk with nothing to swap, so the renderer does not rebuild it", () => {
    const map = world();
    const drawn = withClaimedRewards(map, catalogue("chest-open"), ["first"]);
    const level = levelKey(0);
    const far = chunkKeyFor(FAR_CELL, FAR_CELL);

    expect(drawn.levels[level]?.[far]).toBe(map.levels[level]?.[far]);
    expect(withClaimedRewards(map, catalogue("chest-open"), ["unrelated"])).toBe(map);
  });

  it("leaves a chest alone when its claimed tile is not in the catalogue", () => {
    const map = world();

    expect(withClaimedRewards(map, catalogue("missing"), ["first"])).toBe(map);
  });
});
