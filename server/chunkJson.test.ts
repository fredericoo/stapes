import { describe, expect, it } from "bun:test";
import { chunkKeyFor, emptyMap, setStacks, type StackEdit } from "../app/lib/mapData";
import { cellsOfChunks, interestChunks, mapOfInterest } from "../app/net/interest";
import type { CellAffliction, CellPatch } from "../app/net/protocol";
import { CHUNK_SIZE, type MapFile, type PlacedTile } from "../app/lib/types";
import { handoverCellsJson, mapOfInterestJson } from "./chunkJson";

/**
 * The kept text of a chunk is only a saving if it is the same bytes the objects
 * would have been. Every case here compares against `JSON.stringify` of what
 * `../app/net/interest` builds, which is what the server sent before the text
 * was kept.
 */

const grass: PlacedTile = { tileId: "grass" };
const wall: PlacedTile = { tileId: "wall" };

function body(owner: string, tileId = "player"): PlacedTile {
  return { tileId, owner, direction: "s" } as PlacedTile;
}

/**
 * A board over four chunk columns and three levels: ground everywhere, a wall
 * here and there, a body in some cells and two in one.
 */
function board(): MapFile {
  const edits: StackEdit[] = [];
  for (let x = -CHUNK_SIZE; x < CHUNK_SIZE; x++) {
    for (let y = -CHUNK_SIZE; y < CHUNK_SIZE; y++) {
      const stack: PlacedTile[] = [grass];
      if ((x * 7 + y * 3) % 11 === 0) stack.push(wall);
      edits.push({ x, y, z: 0, stack });
      if ((x + y) % 5 === 0) edits.push({ x, y, z: -1, stack: [grass] });
      if (x % 4 === 0 && y % 3 === 0) edits.push({ x, y, z: 2, stack: [wall] });
    }
  }
  edits.push({ x: 1, y: 1, z: 0, stack: [grass, body("alice")] });
  edits.push({ x: -3, y: 9, z: 0, stack: [grass, body("bob"), body("carol")] });
  edits.push({ x: 20 - CHUNK_SIZE, y: -2, z: 0, stack: [grass, body("npc:rat", "rat")] });
  edits.push({ x: 0, y: 0, z: -1, stack: [grass, body("npc:bat", "bat")] });
  edits.push({ x: 5, y: -5, z: 2, stack: [body("dave")] });
  return setStacks(emptyMap(), edits);
}

const ALL_CHUNKS = ["-1,-1", "-1,0", "0,-1", "0,0", "1,1"];

const HELD_SETS: Array<ReadonlySet<string>> = [
  new Set(),
  new Set(["alice"]),
  new Set(["bob"]),
  new Set(["alice", "bob", "carol", "npc:rat", "npc:bat", "dave"]),
  new Set(["somebody-else"]),
];

const FIRE: CellAffliction[] = [{ tileId: "grass", defIds: ["burning"] }];

/** What the server built before: `cellsOfChunks`, through its `cellPatch`. */
function handoverByObjects(
  map: MapFile,
  chunks: string[],
  held: ReadonlySet<string>,
  burning: (x: number, y: number, z: number) => CellAffliction[] | undefined,
): string {
  return cellsOfChunks(map, chunks, held)
    .map((cell): CellPatch => {
      const afflicted = burning(cell.x, cell.y, cell.z);
      return afflicted
        ? { x: cell.x, y: cell.y, z: cell.z, stack: cell.stack, afflicted }
        : { x: cell.x, y: cell.y, z: cell.z, stack: cell.stack };
    })
    .map((cell) => JSON.stringify(cell))
    .join(",");
}

const NOT_BURNING = () => undefined;

describe("ground handed over as it comes into reach", () => {
  it("is the bytes the objects were, whoever it is handed to", () => {
    const map = board();
    for (const held of HELD_SETS) {
      expect(handoverCellsJson(map, ALL_CHUNKS, held, NOT_BURNING, new Set())).toBe(
        handoverByObjects(map, ALL_CHUNKS, held, NOT_BURNING),
      );
    }
  });

  it("carries a fire on the cell that is burning", () => {
    const map = board();
    const burning = (x: number, y: number, z: number) =>
      x === 2 && y === 3 && z === 0 ? FIRE : undefined;
    const burningChunks = new Set([`0:${chunkKeyFor(2, 3)}`]);
    for (const held of HELD_SETS) {
      expect(handoverCellsJson(map, ALL_CHUNKS, held, burning, burningChunks)).toBe(
        handoverByObjects(map, ALL_CHUNKS, held, burning),
      );
    }
  });

  it("is written afresh for a chunk that has been edited since", () => {
    let map = board();
    // Once to keep the text, then an edit that replaces the chunk.
    handoverCellsJson(map, ALL_CHUNKS, new Set(), NOT_BURNING, new Set());
    map = setStacks(map, [{ x: 1, y: 1, z: 0, stack: [grass, wall] }]);
    expect(handoverCellsJson(map, ALL_CHUNKS, new Set(), NOT_BURNING, new Set())).toBe(
      handoverByObjects(map, ALL_CHUNKS, new Set(), NOT_BURNING),
    );
  });

  it("writes a stack for the cell it is in now, not the cell it was first written for", () => {
    let map = board();
    handoverCellsJson(map, ALL_CHUNKS, new Set(), NOT_BURNING, new Set());
    // The same array, moved to another cell and put on another level too.
    const moved = map.levels["0"]!["0,0"]!["1,1"]!;
    map = setStacks(map, [
      { x: 1, y: 1, z: 0, stack: [] },
      { x: 2, y: 2, z: 0, stack: moved },
      { x: 3, y: 3, z: 2, stack: moved },
    ]);
    for (const held of HELD_SETS) {
      expect(handoverCellsJson(map, ALL_CHUNKS, held, NOT_BURNING, new Set())).toBe(
        handoverByObjects(map, ALL_CHUNKS, held, NOT_BURNING),
      );
      expect(mapOfInterestJson(map, new Set(ALL_CHUNKS), held)).toBe(
        JSON.stringify(mapOfInterest(map, new Set(ALL_CHUNKS), held)),
      );
    }
  });

  it("says nothing about chunks the board does not have", () => {
    expect(handoverCellsJson(board(), ["40,40"], new Set(), NOT_BURNING, new Set())).toBe("");
  });
});

describe("the map a joiner is sent", () => {
  it("is the bytes the objects were, whoever joins", () => {
    const map = board();
    for (const chunks of [
      interestChunks(0, 0),
      interestChunks(CHUNK_SIZE * 6, 0),
      new Set(["0,0"]),
    ]) {
      for (const held of HELD_SETS) {
        expect(mapOfInterestJson(map, chunks, held)).toBe(
          JSON.stringify(mapOfInterest(map, chunks, held)),
        );
      }
    }
  });

  it("is the bytes the objects were after an edit", () => {
    let map = board();
    const chunks = interestChunks(0, 0);
    mapOfInterestJson(map, chunks, new Set());
    map = setStacks(map, [
      { x: 1, y: 1, z: 0, stack: [grass] },
      { x: 2, y: 1, z: 0, stack: [grass, body("alice")] },
    ]);
    for (const held of HELD_SETS) {
      expect(mapOfInterestJson(map, chunks, held)).toBe(
        JSON.stringify(mapOfInterest(map, chunks, held)),
      );
    }
  });

  it("is an empty map for somebody whose reach holds nothing", () => {
    expect(mapOfInterestJson(emptyMap(), interestChunks(0, 0), new Set())).toBe(
      JSON.stringify(mapOfInterest(emptyMap(), interestChunks(0, 0), new Set())),
    );
  });
});
