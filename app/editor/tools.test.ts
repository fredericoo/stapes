import { describe, expect, it } from "vitest";
import { replaceStack } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import { floodCoords } from "./tools";

function mapWith(
  cells: Array<{
    x: number;
    y: number;
    tiles: Array<{ tileId: string; direction?: "n" | "e" | "s" | "w" }>;
  }>,
): MapFile {
  let map: MapFile = { version: 1, levels: {} };
  for (const c of cells) {
    map = replaceStack(map, c.x, c.y, 0, c.tiles);
  }
  return map;
}

describe("floodCoords", () => {
  it("fills contiguous identical stacks", () => {
    const grass = [{ tileId: "grass" }];
    const map = mapWith([
      { x: 0, y: 0, tiles: grass },
      { x: 1, y: 0, tiles: grass },
      { x: 2, y: 0, tiles: grass },
      { x: 1, y: 1, tiles: grass },
    ]);
    const coords = floodCoords(map, 1, 0, 0);
    expect(coords).toEqual(
      expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 1, y: 1 },
      ]),
    );
    expect(coords).toHaveLength(4);
  });

  it("does not cross into disconnected identical stacks", () => {
    const grass = [{ tileId: "grass" }];
    const map = mapWith([
      { x: 0, y: 0, tiles: grass },
      { x: 1, y: 0, tiles: grass },
      // gap at (2,0)
      { x: 3, y: 0, tiles: grass },
    ]);
    const coords = floodCoords(map, 0, 0, 0);
    expect(coords).toEqual(
      expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    );
    expect(coords).toHaveLength(2);
  });

  it("stops at stacks that differ by tile or direction", () => {
    const grass = [{ tileId: "grass" }];
    const map = mapWith([
      { x: 0, y: 0, tiles: grass },
      { x: 1, y: 0, tiles: [{ tileId: "rock" }] },
      { x: 0, y: 1, tiles: [{ tileId: "grass", direction: "n" }] },
      { x: 0, y: -1, tiles: [{ tileId: "grass" }, { tileId: "rock" }] },
    ]);
    expect(floodCoords(map, 0, 0, 0)).toEqual([{ x: 0, y: 0 }]);
  });

  it("refuses to fill empty space", () => {
    const map = mapWith([{ x: 1, y: 1, tiles: [{ tileId: "grass" }] }]);
    expect(floodCoords(map, 0, 0, 0)).toEqual([]);
  });
});
