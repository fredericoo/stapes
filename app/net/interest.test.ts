import { describe, expect, it } from "vitest";
import {
  INTEREST_REACH_CELLS,
  INTEREST_REACH_CHUNKS,
  bucketCellsByChunk,
  cellsOfChunks,
  chunksEntered,
  covers,
  interestChunks,
  mapOfInterest,
  ownersIn,
  patchScope,
  sameChunks,
} from "./interest";
import {
  LIGHT_APRON,
  LIGHT_CHUNK_SIZE,
  LIGHT_WINDOW_MARGIN,
} from "../lib/lightingChunks";
import { emptyMap, replaceStack } from "../lib/mapData";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL, coordKey, levelKey } from "../lib/types";
import type { MapFile } from "../lib/types";
import { VIEW_CELLS } from "../lib/view";

/**
 * What a client is owed.
 *
 * The reach is the whole of this: too small and the client's own sky flood
 * seeds daylight at the edge of what it holds, which is a lit boundary that
 * moves as you walk. Every case below is either about that or about the
 * subscription being a function of where the body is rather than of how big
 * the world is.
 */

function mapAt(...cells: Array<{ x: number; y: number; z: number }>): MapFile {
  let map = emptyMap();
  for (const cell of cells) {
    map = replaceStack(map, cell.x, cell.y, cell.z, [{ tileId: "grass" }]);
  }
  return map;
}

describe("how far a client is told about", () => {
  /**
   * The reach is derived from what the *lighting* reads, and this is that
   * derivation written out a second way. If it ever disagrees with the module,
   * one of the two has stopped tracking the constants it is made of — which is
   * exactly the drift the derivation exists to prevent.
   */
  it("covers everything the client's own light bake can read", () => {
    expect(INTEREST_REACH_CELLS).toBe(
      Math.ceil(VIEW_CELLS / 2) +
        (MAX_LEVEL - MIN_LEVEL) +
        LIGHT_WINDOW_MARGIN +
        LIGHT_CHUNK_SIZE +
        LIGHT_APRON,
    );
  });

  it("reaches past the light apron, whatever the other terms do", () => {
    expect(INTEREST_REACH_CELLS).toBeGreaterThan(LIGHT_APRON + LIGHT_CHUNK_SIZE);
  });

  it("rounds out to whole chunks, never short of the reach", () => {
    expect(INTEREST_REACH_CHUNKS * CHUNK_SIZE).toBeGreaterThanOrEqual(
      INTEREST_REACH_CELLS,
    );
  });
});

describe("the chunks one body is owed", () => {
  it("holds the chunk it is standing in", () => {
    expect(covers(interestChunks(5, 5), 5, 5)).toBe(true);
  });

  it("holds every cell within the reach, on the diagonal too", () => {
    const chunks = interestChunks(0, 0);
    const far = INTEREST_REACH_CELLS;
    expect(covers(chunks, far, 0)).toBe(true);
    expect(covers(chunks, 0, far)).toBe(true);
    expect(covers(chunks, -far, -far)).toBe(true);
  });

  it("stops somewhere, so the map's size is not the subscription's", () => {
    const chunks = interestChunks(0, 0);
    const beyond = (INTEREST_REACH_CHUNKS + 2) * CHUNK_SIZE;
    expect(covers(chunks, beyond, 0)).toBe(false);
  });

  it("is the same square wherever the map happens to have content", () => {
    expect(interestChunks(0, 0).size).toBe(interestChunks(9999, -9999).size);
  });

  it("does not move while the body stays inside one chunk", () => {
    const a = interestChunks(0, 0);
    const b = interestChunks(CHUNK_SIZE - 1, CHUNK_SIZE - 1);
    expect(sameChunks(a, b)).toBe(true);
  });

  it("moves when the body crosses a boundary", () => {
    const a = interestChunks(0, 0);
    const b = interestChunks(CHUNK_SIZE, 0);
    expect(sameChunks(a, b)).toBe(false);
  });
});

describe("what comes into reach", () => {
  it("is nothing at all while the subscription has not moved", () => {
    const chunks = interestChunks(0, 0);
    expect(chunksEntered(chunks, chunks, { x: 0, y: 0 })).toEqual([]);
  });

  it("is one edge of the square for a step across a boundary", () => {
    const before = interestChunks(0, 0);
    const now = interestChunks(CHUNK_SIZE, 0);
    const entered = chunksEntered(before, now, { x: CHUNK_SIZE, y: 0 });

    // One column of the square, which is its side.
    expect(entered.length).toBe(INTEREST_REACH_CHUNKS * 2 + 1);
  });

  it("is the whole square for somebody who has just arrived", () => {
    const now = interestChunks(0, 0);
    expect(chunksEntered(undefined, now, { x: 0, y: 0 }).length).toBe(now.size);
  });

  /**
   * The budget hands over a few per tick, so the order decides whether those
   * few are the ground being walked onto or a corner of the square being walked
   * away from.
   */
  it("puts the nearest chunks first, so a budget spends them well", () => {
    const before = interestChunks(0, 0);
    const now = interestChunks(CHUNK_SIZE * 3, 0);
    const at = { x: CHUNK_SIZE * 3, y: 0 };
    const entered = chunksEntered(before, now, at);

    const distances = entered.map((key) => {
      const [kx, ky] = key.split(",").map(Number) as [number, number];
      return Math.max(Math.abs(kx - 3), Math.abs(ky - 0));
    });
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });
});

describe("handing the cells over", () => {
  it("sends a chunk's cells on every level it has any", () => {
    const map = mapAt(
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 2, z: -3 },
      { x: 3, y: 3, z: 4 },
    );

    const cells = cellsOfChunks(map, ["0,0"]);

    expect(cells.map((c) => c.z).sort((a, b) => a - b)).toEqual([-3, 0, 4]);
  });

  it("says nothing about a chunk the map does not have", () => {
    expect(cellsOfChunks(mapAt({ x: 1, y: 1, z: 0 }), ["9,9"])).toEqual([]);
  });

  it("gives a joiner the flat shape it already parses", () => {
    const map = mapAt({ x: 1, y: 1, z: 0 });

    const flat = mapOfInterest(map, interestChunks(1, 1));

    expect(flat.version).toBe(1);
    expect(flat.levels[levelKey(0)]?.[coordKey(1, 1)]).toEqual([
      { tileId: "grass" },
    ]);
  });

  it("leaves out what the subscription does not reach", () => {
    const far = (INTEREST_REACH_CHUNKS + 3) * CHUNK_SIZE;
    const map = mapAt({ x: 1, y: 1, z: 0 }, { x: far, y: far, z: 0 });

    const flat = mapOfInterest(map, interestChunks(1, 1));

    expect(flat.levels[levelKey(0)]?.[coordKey(1, 1)]).toBeDefined();
    expect(flat.levels[levelKey(0)]?.[coordKey(far, far)]).toBeUndefined();
  });

  /**
   * Scoping by level as well is the tempting next step and is a trap: you can
   * see down a hole into the floor below, a pit drops you a level without
   * warning, and a ramp is a level change you walk up. A body has to land
   * somewhere it has been told about.
   */
  it("holds every level of the chunks it holds", () => {
    let map = emptyMap();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      map = replaceStack(map, 1, 1, z, [{ tileId: "grass" }]);
    }

    const flat = mapOfInterest(map, interestChunks(1, 1));

    expect(Object.keys(flat.levels).length).toBe(MAX_LEVEL - MIN_LEVEL + 1);
  });
});

/**
 * Cutting the tick's patch to what each client holds.
 *
 * The property being defended is not bandwidth. It is that a client cannot
 * learn where a body is standing on ground it has never been sent — so the
 * subscription is the only lever, and anything that narrows it narrows the wire
 * in the same edit.
 */
describe("scoping the tick patch", () => {
  const cell = (x: number, y: number) => ({ x, y, z: 0, stack: [] });

  it("groups a tick's cells by the chunk they sit in", () => {
    const buckets = bucketCellsByChunk([
      cell(0, 0),
      cell(CHUNK_SIZE, 0),
      cell(1, 1),
    ]);
    expect(buckets.map((b) => b.chunk)).toEqual(["0,0", "1,0"]);
    expect(buckets[0]!.cells).toEqual([cell(0, 0), cell(1, 1)]);
    expect(buckets[1]!.cells).toEqual([cell(CHUNK_SIZE, 0)]);
  });

  it("gives a client only the chunks it holds", () => {
    const buckets = bucketCellsByChunk([cell(0, 0), cell(CHUNK_SIZE, 0)]);
    const scope = patchScope(buckets, new Set(["1,0"]));
    expect(scope.cells).toEqual([cell(CHUNK_SIZE, 0)]);
  });

  /**
   * The whole reason the key exists: two clients owed the same chunks are owed
   * the same bytes, so the tick pays one `JSON.stringify` for both. What bounds
   * the number of payloads is what moved, never how many people are playing.
   */
  it("gives clients owed the same chunks the same key", () => {
    const buckets = bucketCellsByChunk([cell(0, 0), cell(CHUNK_SIZE, 0)]);
    const here = patchScope(buckets, new Set(["0,0", "9,9"]));
    const alsoHere = patchScope(buckets, new Set(["0,0", "4,4"]));
    const elsewhere = patchScope(buckets, new Set(["1,0"]));
    expect(here.key).toBe(alsoHere.key);
    expect(here.key).not.toBe(elsewhere.key);
  });

  it("gives a client that holds none of them nothing at all", () => {
    const buckets = bucketCellsByChunk([cell(0, 0)]);
    expect(patchScope(buckets, new Set(["7,7"])).cells).toEqual([]);
  });

  /**
   * Before a `hello` is answered there is no subscription on record, and the
   * safe reading is the one that predates scoping. A client shown ground it did
   * not ask for draws a correct world; one denied ground it holds draws a hole.
   */
  it("sends everything to a client with no subscription yet", () => {
    const buckets = bucketCellsByChunk([cell(0, 0), cell(CHUNK_SIZE, 0)]);
    expect(patchScope(buckets, undefined).cells).toHaveLength(2);
  });

  it("names the bodies standing in some cells", () => {
    const cells = [
      { x: 0, y: 0, z: 0, stack: [{ tileId: "grass" }, { tileId: "rat", owner: "rat:1" }] },
      { x: 1, y: 0, z: 0, stack: [{ tileId: "grass" }] },
      { x: 2, y: 0, z: 0, stack: [{ tileId: "player", owner: "alice" }] },
    ];
    expect(ownersIn(cells)).toEqual(new Set(["rat:1", "alice"]));
  });
});
