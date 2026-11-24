import { describe, expect, it } from "vitest";
import { BoardChunks, chunksInView } from "./boardView";
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

  it("leaves out the chunks only a level above an isolated one would show", () => {
    expect(chunksInView(CHUNK_ZERO, 0, [0, 8], 0)).not.toContain("2,2");
  });

  it("reads nothing when no level the board has is drawn", () => {
    expect(chunksInView(CHUNK_ZERO, -20, [0, 1])).toEqual([]);
  });
});

describe("BoardChunks", () => {
  it("asks only for chunks the board has and nobody has read yet", () => {
    const board = new BoardChunks(["0,0", "1,0"]);
    board.add(["0,0"], [row("0", "0,0")]);

    expect(board.missing(["0,0", "1,0", "5,5"])).toEqual(["1,0"]);
  });

  it("does not ask again for a chunk that came back with no rows", () => {
    const board = new BoardChunks(["0,0"]);
    board.add(["0,0"], []);

    expect(board.missing(["0,0"])).toEqual([]);
  });

  it("draws every level of what it read, or only up to an isolated level", () => {
    const board = new BoardChunks(["0,0"]);
    board.add(["0,0"], [row("-1", "0,0"), row("0", "0,0"), row("2", "0,0")]);

    expect(Object.keys(board.map().levels).sort()).toEqual(["-1", "0", "2"]);
    expect(Object.keys(board.map(0).levels).sort()).toEqual(["-1", "0"]);
  });

  it("drops the chunks read longest ago, never one still in view", () => {
    const board = new BoardChunks(["0,0", "1,0", "2,0", "3,0"]);
    for (const key of ["0,0", "1,0", "2,0", "3,0"]) board.add([key], [row("0", key)]);

    board.trim(["0,0"], 2);

    expect(Object.keys(board.map().levels["0"]!).sort()).toEqual(["0,0", "3,0"]);
    expect(board.missing(["1,0", "2,0"])).toEqual(["1,0", "2,0"]);
  });
});
