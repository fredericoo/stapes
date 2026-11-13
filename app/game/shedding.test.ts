import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { countOf } from "../lib/piles";
import { FRAME, tile } from "../lib/testTile";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

const FALL_MS = 3000;
const LIMIT = 2;
const HALF = 4;

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "rock", height: 4, walkable: false }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({ id: "apple", kind: "item", interactions: { item: { type: "artifact" } } }),
  tile({
    id: "apple-tree",
    height: 4,
    walkable: false,
    interactions: { shed: { tileId: "apple", fromMs: FALL_MS, toMs: FALL_MS, max: LIMIT } },
  }),
];

function field(): MapFile {
  let map = emptyMap();
  for (let x = -HALF; x <= HALF; x++) {
    for (let y = -HALF; y <= HALF; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, -HALF, -HALF, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "apple-tree" }]);
}

function put(map: MapFile, x: number, y: number, placed: PlacedTile): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, placed]);
}

function run(session: GameSession, ms: number) {
  for (let i = 0; i < Math.ceil(ms / TICK_MS); i++) session.tick(TICK_MS);
}

function apples(session: GameSession): Map<string, number> {
  const out = new Map<string, number>();
  for (let x = -HALF; x <= HALF; x++) {
    for (let y = -HALF; y <= HALF; y++) {
      const n = getStack(session.getMap(), x, y, 0)
        .filter((placed) => placed.tileId === "apple")
        .reduce((sum, placed) => sum + countOf(placed), 0);
      if (n > 0) out.set(`${x},${y}`, n);
    }
  }
  return out;
}

function total(session: GameSession): number {
  return [...apples(session).values()].reduce((a, b) => a + b, 0);
}

describe("a tile that sheds", () => {
  it("drops its item on a cell beside it once the wait is up", () => {
    const session = new GameSession(field(), tiles);
    run(session, FALL_MS - 1000);
    expect(total(session)).toBe(0);

    run(session, 2000);
    const [cell] = [...apples(session).keys()];
    expect(total(session)).toBe(1);
    const [x, y] = cell!.split(",").map(Number);
    expect(Math.max(Math.abs(x!), Math.abs(y!))).toBe(1);
  });

  it("keeps dropping until the limit lies around it, then stops", () => {
    const session = new GameSession(field(), tiles);
    run(session, FALL_MS * (LIMIT + 3));
    expect(total(session)).toBe(LIMIT);
  });

  it("counts a pile beside it by its size", () => {
    const map = put(field(), 1, 0, { tileId: "apple", itemId: "pile", count: LIMIT });
    const session = new GameSession(map, tiles);
    run(session, FALL_MS * 3);
    expect(apples(session)).toEqual(new Map([["1,0", LIMIT]]));
  });

  it("drops only on a neighbour with a floor to take it", () => {
    let map = field();
    for (const [x, y] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
    ]) {
      map = put(map, x!, y!, { tileId: "rock" });
    }
    const session = new GameSession(map, tiles);
    run(session, FALL_MS + 1000);
    expect(apples(session)).toEqual(new Map([["1,1", 1]]));
  });
});
