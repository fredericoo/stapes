import { describe, expect, it } from "vitest";
import tilesFile from "../../data/tiles.json";
import { PLAYER_TILE_ID } from "../game/constants";
import { emptyMap, getStack, replaceStack } from "./mapData";
import type { PlacedTile } from "./types";
import { normalizeTileDef } from "./types";
import { removeUnfitPlacements, tilesByIdFromList } from "./validation";

const tilesById = tilesByIdFromList((tilesFile as unknown[]).map((raw) => normalizeTileDef(raw)));

function stackOf(...tileIds: string[]): PlacedTile[] {
  return tileIds.map((tileId) => ({ tileId }));
}

describe("removeUnfitPlacements", () => {
  it("takes the top barrel off two that overflow into an occupied level", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, stackOf("wooden-floor", "barrel", "barrel"));
    map = replaceStack(map, 0, 0, 1, stackOf("wooden-floor"));

    const result = removeUnfitPlacements(map, tilesById);

    expect(getStack(result.map, 0, 0, 0)).toEqual(stackOf("wooden-floor", "barrel"));
    expect(getStack(result.map, 0, 0, 1)).toEqual(stackOf("wooden-floor"));
    expect(result.removed).toEqual([
      expect.objectContaining({ x: 0, y: 0, z: 0, tileId: "barrel" }),
    ]);
  });

  it("returns the map it was given when every placement fits", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, stackOf("grass", "barrel", "barrel"));
    map = replaceStack(map, 1, 0, 0, stackOf("grass", "stone-wall"));
    map = replaceStack(map, 1, 0, 1, stackOf("grass"));

    const result = removeUnfitPlacements(map, tilesById);

    expect(result.map).toBe(map);
    expect(result.removed).toEqual([]);
  });

  it("refuses a map whose player marker does not fit, rather than removing the marker", () => {
    const map = replaceStack(emptyMap(), 3, 4, 0, stackOf("grass", "stone-wall", PLAYER_TILE_ID));

    expect(() => removeUnfitPlacements(map, tilesById)).toThrow(/at 3,4 on level 0/);
  });

  it("leaves a placement whose tile is not in the catalogue", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, stackOf("stone-wall", "renamed-crate"));
    map = replaceStack(map, 0, 0, 1, stackOf("grass"));

    expect(removeUnfitPlacements(map, tilesById).map).toBe(map);
  });
});
