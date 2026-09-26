import { describe, expect, it } from "vitest";
import {
  cellInMeshWindow,
  MESH_WINDOW_MARGIN,
  chunkAddressKey,
  parseChunkAddress,
  visibleChunkKeys,
} from "./meshWindow";
import { emptyMap, replaceStack } from "../lib/mapData";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { MapFile } from "../lib/types";

const WINDOW = { x0: 10, y0: 10, x1: 25, y1: 25 };

function mapAt(...cells: Array<{ x: number; y: number; z: number }>): MapFile {
  let map = emptyMap();
  for (const cell of cells) {
    map = replaceStack(map, cell.x, cell.y, cell.z, [{ tileId: "grass" }]);
  }
  return map;
}

function addressOf(x: number, y: number, z: number): string {
  return chunkAddressKey(z, `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`);
}

describe("which chunks are worth meshing", () => {
  it("takes the chunk the window is over", () => {
    const map = mapAt({ x: 20, y: 20, z: 0 });

    expect([...visibleChunkKeys(map, WINDOW)]).toEqual([addressOf(20, 20, 0)]);
  });

  it("leaves a chunk of the same level well outside it", () => {
    const far = { x: CHUNK_SIZE * 20, y: CHUNK_SIZE * 20, z: 0 };
    const map = mapAt({ x: 20, y: 20, z: 0 }, far);

    const keys = visibleChunkKeys(map, WINDOW);

    expect(keys.has(addressOf(far.x, far.y, 0))).toBe(false);
    expect(keys.has(addressOf(20, 20, 0))).toBe(true);
  });

  it("asks about a chunk the map does not have without inventing it", () => {
    expect([...visibleChunkKeys(emptyMap(), WINDOW)]).toEqual([]);
  });

  it("follows the level shift down as well as up", () => {
    const high = { x: 34, y: 34, z: MAX_LEVEL };
    const low = { x: -10, y: -10, z: MIN_LEVEL };
    const map = mapAt(high, low);

    const keys = visibleChunkKeys(map, WINDOW);

    expect(keys.has(addressOf(high.x, high.y, high.z))).toBe(true);
    expect(keys.has(addressOf(low.x, low.y, low.z))).toBe(true);
  });

  it("reaches far enough past the camera to catch a tall sprite", () => {
    const TALLEST_SPRITE_CELLS = 4;
    const window = { x0: 4, y0: 4, x1: 12, y1: 12 };
    const below = {
      x: window.x1 + TALLEST_SPRITE_CELLS,
      y: window.y1 + TALLEST_SPRITE_CELLS,
      z: 0,
    };
    const far = { x: window.x1 + CHUNK_SIZE * 3, y: window.y1 + CHUNK_SIZE * 3, z: 0 };
    const map = mapAt(below, far);

    const keys = visibleChunkKeys(map, window);

    expect(keys.has(addressOf(below.x, below.y, 0))).toBe(true);
    expect(keys.has(addressOf(far.x, far.y, 0))).toBe(false);
  });

  it("answers with the window's chunks however big the level is", () => {
    const SPAN = 10;
    let dense = emptyMap();
    for (let cx = -SPAN; cx < SPAN; cx++) {
      for (let cy = -SPAN; cy < SPAN; cy++) {
        dense = replaceStack(dense, cx * CHUNK_SIZE, cy * CHUNK_SIZE, 0, [{ tileId: "grass" }]);
      }
    }

    expect(visibleChunkKeys(dense, WINDOW).size).toBe(4);
  });

  it("looks at every level, since a cut roof is still built", () => {
    let map = emptyMap();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      map = replaceStack(map, 20 + z, 20 + z, z, [{ tileId: "grass" }]);
    }

    expect(visibleChunkKeys(map, WINDOW).size).toBe(MAX_LEVEL - MIN_LEVEL + 1);
  });
});

describe("naming a chunk of a level", () => {
  it("reads back what it wrote, negatives included", () => {
    expect(parseChunkAddress(chunkAddressKey(-3, "-2,-7"))).toEqual({
      z: -3,
      chunk: "-2,-7",
    });
  });
});

describe("whether a cell is inside what is drawn", () => {
  const window = { x0: 0, y0: 0, x1: 20, y1: 20 };

  it("takes a cell inside the rect, margin included", () => {
    expect(cellInMeshWindow(window, 10, 10, 0)).toBe(true);
    expect(cellInMeshWindow(window, -MESH_WINDOW_MARGIN, 0, 0)).toBe(true);
  });

  it("refuses a cell past the margin", () => {
    expect(cellInMeshWindow(window, -MESH_WINDOW_MARGIN - 1, 0, 0)).toBe(false);
    expect(cellInMeshWindow(window, 0, 21 + MESH_WINDOW_MARGIN, 0)).toBe(false);
  });

  it("shifts the rect with the level, as the projection does", () => {
    const LEVEL = 3;
    const x = 20 + MESH_WINDOW_MARGIN + LEVEL;
    expect(cellInMeshWindow(window, x, 10, LEVEL)).toBe(true);
    expect(cellInMeshWindow(window, x, 10, 0)).toBe(false);
  });
});
