import { describe, expect, it } from "vitest";
import { getStack } from "./mapData";
import { buildScene } from "./scene";
import { tile } from "./testTile";
import type { TileDef } from "./types";

const tiles: Record<string, TileDef> = {
  grass: tile({ id: "grass" }),
  water: tile({ id: "water" }),
  hound: tile({ id: "hound", height: 2 }),
};

describe("buildScene", () => {
  it("fills a rectangle, then lets a later entry replace one of its cells", () => {
    const { map } = buildScene(
      {
        cells: [
          { from: [0, 0], to: [2, 1], tiles: ["grass"] },
          { at: [1, 1], tiles: ["grass", { tile: "hound", facing: "e" }] },
        ],
      },
      tiles,
    );

    expect(getStack(map, 2, 1, 0)).toEqual([{ tileId: "grass" }]);
    expect(getStack(map, 1, 1, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "hound", direction: "e" },
    ]);
  });

  it("looks at the middle of the scene unless told where to look", () => {
    const cells = [
      { from: [-2, 0] as [number, number], to: [4, 6] as [number, number], tiles: ["grass"] },
    ];
    expect(buildScene({ cells }, tiles).look).toEqual({ x: 1, y: 3, z: 0 });
    expect(buildScene({ cells, look: [4, 6] }, tiles).look).toEqual({ x: 4, y: 6, z: 0 });
  });

  it("names what is wrong with a scene it cannot build", () => {
    const at: [number, number] = [0, 0];
    expect(() => buildScene({ cells: [{ at, tiles: ["lava"] }] }, tiles)).toThrow(
      'No tile called "lava"',
    );
    expect(() => buildScene({ cells: [{ at, tiles: ["grass"] }], time: "25:00" }, tiles)).toThrow(
      '"25:00" is not a time',
    );
  });
});
