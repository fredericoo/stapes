import { describe, expect, it } from "vitest";
import { BoardChunks, chunksInView, drawnLevels, topLevelShown } from "./boardView";
import type { ChangedChunk } from "./mapData";

/** A screen that shows only chunk 0,0 of the ground level. */
const CHUNK_ZERO = { left: 0, top: 0, width: 120, height: 120 };

function row(levelKey: string, chunkKey: string): ChangedChunk {
  return { levelKey, chunkKey, cells: { "0,0": [{ tileId: "grass" }] } };
}

describe("chunksInView", () => {
  it("reads the chunk in the middle of the view first, and a chunk of margin round it", () => {
    const keys = chunksInView(CHUNK_ZERO, 0, [0]);

    expect(keys[0]).toBe("0,0");
    expect(new Set(keys)).toEqual(
      new Set(["-1,-1", "0,-1", "1,-1", "-1,0", "0,0", "1,0", "-1,1", "0,1", "1,1"]),
    );
  });

  it("reaches further down and right for a higher level, which is drawn shifted up and left", () => {
    expect(chunksInView(CHUNK_ZERO, 0, [0, 8])).toContain("2,2");
    expect(chunksInView(CHUNK_ZERO, 0, [0])).not.toContain("2,2");
  });
});

describe("drawnLevels", () => {
  it("keeps the board's levels within eight of the view", () => {
    expect(drawnLevels(0, [-9, -8, 0, 8, 9])).toEqual([-8, 0, 8]);
  });

  it("leaves out every level above the top one shown", () => {
    expect(drawnLevels(0, [0, 8], 0)).toEqual([0]);
  });
});

describe("topLevelShown", () => {
  it("hides the surface from a view below ground, isolated or not", () => {
    expect(drawnLevels(-3, [-4, -3, -1, 0, 2], topLevelShown(-3, false))).toEqual([-4, -3, -1]);
  });

  it("hides nothing above ground unless a level is isolated", () => {
    expect(topLevelShown(0, false)).toBe(Number.POSITIVE_INFINITY);
    expect(topLevelShown(-3, true)).toBe(-3);
  });
});

describe("BoardChunks", () => {
  it("asks only for chunks the board has and nobody has read on every drawn level", () => {
    const board = new BoardChunks(["0,0", "1,0", "2,0"]);
    board.add(["0,0"], [0, 1], [row("0", "0,0")]);
    board.add(["2,0"], [0], [row("0", "2,0")]);

    expect(board.missing(["0,0", "1,0", "2,0", "5,5"], [0, 1])).toEqual(["1,0", "2,0"]);
  });

  it("asks for the narrowest range of levels that some chunk lacks", () => {
    const board = new BoardChunks(["0,0", "1,0"]);
    board.add(["0,0", "1,0"], [-1, 0, 1], []);
    board.add(["1,0"], [2], []);

    expect(board.missingRange(["0,0", "1,0"], [-1, 0, 1, 2, 3])).toEqual({ z0: 2, z1: 3 });
    expect(board.missingRange(["1,0"], [-1, 0, 1, 2])).toBeNull();
  });

  it("does not ask again for a level that came back with no row", () => {
    const board = new BoardChunks(["0,0"]);
    board.add(["0,0"], [0], []);

    expect(board.missing(["0,0"], [0])).toEqual([]);
  });

  it("draws every level of what it read, or only up to the top level shown", () => {
    const board = new BoardChunks(["0,0"]);
    board.add(["0,0"], [-1, 0, 2], [row("-1", "0,0"), row("0", "0,0"), row("2", "0,0")]);

    expect(Object.keys(board.map().levels).sort()).toEqual(["-1", "0", "2"]);
    expect(Object.keys(board.map(0).levels).sort()).toEqual(["-1", "0"]);
  });

  it("forgets chunks further than the margin from the view, and keeps those within it", () => {
    const board = new BoardChunks(["0,0", "2,0", "3,0"]);
    for (const key of ["0,0", "2,0", "3,0"]) board.add([key], [0], [row("0", key)]);

    expect(board.trim(["0,0"], { z0: -8, z1: 8 }, 2)).toBe(true);

    expect(Object.keys(board.map().levels["0"]!).sort()).toEqual(["0,0", "2,0"]);
    expect(board.missing(["3,0"], [0])).toEqual(["3,0"]);
  });

  it("forgets the levels that left the view's reach", () => {
    const board = new BoardChunks(["0,0"]);
    board.add(["0,0"], [0, 9], [row("0", "0,0"), row("9", "0,0")]);

    board.trim(["0,0"], { z0: -8, z1: 8 }, 2);

    expect(Object.keys(board.map().levels)).toEqual(["0"]);
    expect(board.missing(["0,0"], [9])).toEqual(["0,0"]);
  });
});
