import { describe, expect, it } from "vitest";
import { replaceStack } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import { floodCoords } from "./tools";

function mapWith(
  cells: Array<{ x: number; y: number; tiles: Array<{ tileId: string; direction?: "n" | "e" | "s" | "w" }> }>,
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

  it("fills blank cells enclosed by an outline", () => {
    const rock = [{ tileId: "rock" }];
    // A 4x4 ring of rock around a 2x2 blank middle.
    const ring: Array<{ x: number; y: number; tiles: typeof rock }> = [];
    for (let y = 0; y <= 3; y++) {
      for (let x = 0; x <= 3; x++) {
        if (x === 0 || x === 3 || y === 0 || y === 3) {
          ring.push({ x, y, tiles: rock });
        }
      }
    }
    const coords = floodCoords(mapWith(ring), 1, 1, 0);
    expect(coords).toEqual(
      expect.arrayContaining([
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ]),
    );
    expect(coords).toHaveLength(4);
  });

  it("fills nothing when the blank region leaks out of the outline", () => {
    const rock = [{ tileId: "rock" }];
    const ring: Array<{ x: number; y: number; tiles: typeof rock }> = [];
    for (let y = 0; y <= 3; y++) {
      for (let x = 0; x <= 3; x++) {
        // Same ring, with (3,1) missing so the inside reaches open world.
        if ((x === 0 || x === 3 || y === 0 || y === 3) && !(x === 3 && y === 1)) {
          ring.push({ x, y, tiles: rock });
        }
      }
    }
    expect(floodCoords(mapWith(ring), 1, 1, 0)).toEqual([]);
  });

  it("refuses to fill the void outside the map", () => {
    const map = mapWith([{ x: 1, y: 1, tiles: [{ tileId: "grass" }] }]);
    expect(floodCoords(map, 40, 40, 0)).toEqual([]);
  });

  it("refuses to fill a level with nothing on it", () => {
    expect(floodCoords(mapWith([]), 0, 0, 0)).toEqual([]);
  });
});
