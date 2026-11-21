import { describe, expect, it } from "vitest";
import tilesRaw from "../../data/tiles.json";
import { PLAYER_TILE_ID } from "../game/constants";
import { reachableCells } from "../game/navigation";
import { emptyMap, getStack, setStacks, type StackEdit } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  FLOOR_USES,
  planBuilding,
  type Access,
  type BuildingSpec,
  type FloorSpec,
  type FloorUse,
} from "./building";

const tilesById = tilesByIdFromList(normalizeTiles(tilesRaw as unknown[]));

function lawn(size: number): MapFile {
  const edits: StackEdit[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) edits.push({ x, y, z: 0, stack: [{ tileId: "grass" }] });
  }
  return setStacks(emptyMap(), edits);
}

function storey(name: string, over: Partial<FloorSpec> = {}): FloorSpec {
  return {
    name,
    use: "house",
    seed: 1,
    rooms: 1,
    roomDoors: true,
    stocked: true,
    access: "stairs",
    stairsTileId: "stone-stairs",
    doors: [],
    wallTileId: "sw2",
    floorTileId: "wooden-floor",
    windowTileId: "window-1",
    windowSpacing: 3,
    doorTileId: "door-closed",
    ...over,
  };
}

const RECT = { x0: 4, y0: 4, x1: 12, y1: 11 };
const FRONT_DOOR = { x: 8, y: 11 };
const OUTSIDE = { x: 8, y: 13, z: 0 };

function built(spec: BuildingSpec, rect = RECT) {
  const map = lawn(20);
  const plan = planBuilding(map, tilesById, rect, 0, spec);
  if (!plan.ok) throw new Error(plan.reason);
  return setStacks(map, plan.edits);
}

/** The levels a player who starts on the lawn outside can get to and get back from. */
function levelsWalked(map: MapFile, from = OUTSIDE): number[] {
  const world = { board: map, traveller: tilesById[PLAYER_TILE_ID]!, tilesById, statusDefs: {} };
  const out = [...reachableCells(world, [from]).values()];
  const home = `${from.x},${from.y},${from.z}`;
  const levels = new Set<number>();
  for (const cell of out) {
    if (levels.has(cell.z)) continue;
    const back = reachableCells(world, [cell]);
    if ([...back.values()].some((c) => `${c.x},${c.y},${c.z}` === home)) levels.add(cell.z);
  }
  return [...levels].sort((a, b) => a - b);
}

function tower(access: Access, use: FloorUse, seed: number, rooms: number): BuildingSpec {
  const of = (name: string, over: Partial<FloorSpec> = {}) =>
    storey(name, { access, use, seed: seed + name.length, rooms, ...over });
  return {
    floors: [of("ground", { doors: [FRONT_DOOR] }), of("first"), of("second-floor")],
    cellars: [of("cellar"), of("deep-cellar")],
    roof: { colour: "red", pitch: "steep", orientation: "auto" },
  };
}

describe("planBuilding", () => {
  it.each(FLOOR_USES.flatMap((use) => [1, 2, 3].map((seed) => [use, seed] as const)))(
    "joins every floor and cellar of a %s by stairs, seed %i",
    (use, seed) => {
      const map = built(tower("stairs", use, seed, 3));
      expect(levelsWalked(map)).toEqual([-2, -1, 0, 1, 2]);
    },
  );

  it("joins every floor and cellar by ladders when asked to", () => {
    const map = built(tower("ladder", "house", 5, 2));
    expect(levelsWalked(map)).toEqual([-2, -1, 0, 1, 2]);
    const ladders = (z: number, tileId: string) => {
      let count = 0;
      for (let y = 4; y <= 11; y++) {
        for (let x = 4; x <= 12; x++) {
          if (getStack(map, x, y, z).some((p) => p.tileId === tileId)) count++;
        }
      }
      return count;
    };
    expect([-2, -1, 0, 1].map((z) => ladders(z, "ladder-up"))).toEqual([1, 1, 1, 1]);
    expect([-1, 0, 1, 2].map((z) => ladders(z, "stone-stairs"))).toEqual([0, 0, 0, 0]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "builds a flight as two stairs, the second on a block, under a hole railed on three sides, seed %i",
    (seed) => {
      const spec: BuildingSpec = {
        floors: [storey("ground", { use: "empty" }), storey("upper", { use: "empty", seed })],
        cellars: [],
        roof: null,
      };
      const map = built(spec);
      const ids = (x: number, y: number, z: number) => getStack(map, x, y, z).map((p) => p.tileId);
      const stairs: Array<{ x: number; y: number }> = [];
      for (let y = 5; y <= 10; y++) {
        for (let x = 5; x <= 11; x++)
          if (ids(x, y, 0).at(-1) === "stone-stairs") stairs.push({ x, y });
      }
      expect(stairs.map((c) => ids(c.x, c.y, 0)).sort((a, b) => a.length - b.length)).toEqual([
        ["grass", "wooden-floor", "stone-stairs"],
        ["grass", "wooden-floor", "brick-slab", "stone-stairs"],
      ]);
      const hole = new Set(stairs.map((c) => `${c.x},${c.y}`));
      const beside = new Map<string, string | undefined>();
      for (const c of stairs) {
        expect(ids(c.x, c.y, 1)).toEqual([]);
        for (const [dx, dy] of [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ] as const) {
          const key = `${c.x + dx},${c.y + dy}`;
          if (!hole.has(key)) beside.set(key, ids(c.x + dx, c.y + dy, 1).at(-1));
        }
      }
      const tops = [...beside.values()];
      expect(tops).toHaveLength(6);
      expect(tops.filter((id) => id === "wooden-floor-inner")).toHaveLength(1);
      expect(tops.filter((id) => id === "fence")).toHaveLength(5);
    },
  );

  it.each([
    ["stone-stairs", "brick-slab"],
    ["ramp", "half-stone"],
    ["snowy-ramp", "frosted-half-stone"],
  ])("builds a flight of %s on a %s and keeps it walkable", (stairsTileId, block) => {
    const map = built({
      floors: [
        storey("ground", { use: "empty", doors: [FRONT_DOOR] }),
        storey("upper", { use: "empty", stairsTileId }),
      ],
      cellars: [],
      roof: null,
    });
    const flights: string[][] = [];
    for (let y = 5; y <= 10; y++) {
      for (let x = 5; x <= 11; x++) {
        const stack = getStack(map, x, y, 0).map((p) => p.tileId);
        if (stack.at(-1) === stairsTileId) flights.push(stack.slice(2));
      }
    }
    expect(flights.sort((a, b) => a.length - b.length)).toEqual([
      [stairsTileId],
      [block, stairsTileId],
    ]);
    expect(levelsWalked(map)).toEqual([0, 1]);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "keeps a cell of floor between a flight and every outer wall, so no floor padding shows outside, seed %i",
    (seed) => {
      const map = built(tower("stairs", "house", seed, 2));
      let stairs = 0;
      for (const z of [-2, -1, 0, 1, 2]) {
        for (let y = 4; y <= 11; y++) {
          for (let x = 4; x <= 12; x++) {
            const stack = getStack(map, x, y, z).map((p) => p.tileId);
            const outerWall = x === 4 || x === 12 || y === 4 || y === 11;
            if (outerWall) expect(stack, `${x},${y},${z}`).not.toContain("wooden-floor-inner");
            if (stack.at(-1) !== "stone-stairs") continue;
            stairs++;
            expect(x, `stair at ${x},${y},${z}`).toBeGreaterThanOrEqual(6);
            expect(x, `stair at ${x},${y},${z}`).toBeLessThanOrEqual(10);
            expect(y, `stair at ${x},${y},${z}`).toBeGreaterThanOrEqual(6);
            expect(y, `stair at ${x},${y},${z}`).toBeLessThanOrEqual(9);
          }
        }
      }
      expect(stairs).toBe(8);
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    "leaves the cell south of every stair and ladder bare so no wall hides it, seed %i",
    (seed) => {
      const access = seed % 2 ? "stairs" : "ladder";
      const map = built(tower(access, "library", seed, 4));
      const WAYS = ["stone-stairs", "ladder-up", "ladder-top"];
      const FLOORS = ["wooden-floor", "wooden-floor-inner"];
      let found = 0;
      for (const z of [-2, -1, 0, 1, 2]) {
        for (let y = 5; y <= 10; y++) {
          for (let x = 5; x <= 11; x++) {
            const top = getStack(map, x, y, z).at(-1)?.tileId;
            if (!top || !WAYS.includes(top)) continue;
            found++;
            const south = getStack(map, x, y + 1, z).at(-1)?.tileId;
            const fine = south === undefined || FLOORS.includes(south) || WAYS.includes(south);
            expect(fine, `${top} at ${x},${y},${z} has ${south} south of it`).toBe(true);
          }
        }
      }
      expect(found).toBeGreaterThanOrEqual(8);
    },
  );

  it("falls back to a ladder where a flight of stairs does not fit", () => {
    const spec: BuildingSpec = {
      floors: [storey("ground", { doors: [{ x: 5, y: 6 }], use: "empty" }), storey("loft")],
      cellars: [],
      roof: null,
    };
    const map = built(spec, { x0: 4, y0: 4, x1: 6, y1: 6 });
    expect(getStack(map, 5, 5, 0).at(-1)?.tileId).toBe("ladder-up");
    expect(levelsWalked(map, { x: 5, y: 8, z: 0 })).toEqual([0, 1]);
  });

  it("refuses a building with no room for any way up, rather than building floors nobody can reach", () => {
    const spec: BuildingSpec = {
      floors: [storey("ground"), storey("middle"), storey("top")],
      cellars: [],
      roof: null,
    };
    const plan = planBuilding(lawn(20), tilesById, { x0: 4, y0: 4, x1: 6, y1: 6 }, 0, spec);
    expect(plan).toEqual({
      ok: false,
      reason: "There is no room for a way between middle and top. Make the house larger.",
    });
  });

  it("puts a door in the outer wall nearest each point and never in a corner", () => {
    const doors = [
      { x: 8, y: 20 },
      { x: 0, y: 7 },
      { x: 9, y: 5 },
      { x: 4, y: 4 },
    ];
    const map = built({ floors: [storey("ground", { doors })], cellars: [], roof: null });
    const doorAt = (x: number, y: number) => {
      const top = getStack(map, x, y, 0).at(-1);
      return top?.tileId === "door-closed" ? top.direction : null;
    };
    expect(doorAt(8, 11)).toBe("s");
    expect(doorAt(4, 7)).toBe("w");
    expect(doorAt(9, 4)).toBe("n");
    expect([doorAt(5, 4), doorAt(4, 5)].filter(Boolean)).toHaveLength(1);
    expect(doorAt(4, 4)).toBeNull();
  });

  it("hangs a door in each doorway between rooms, and leaves it open when told to", () => {
    const of = (roomDoors: boolean): BuildingSpec => ({
      floors: [storey("ground", { use: "empty", rooms: 3, roomDoors, doors: [] })],
      cellars: [],
      roof: null,
    });
    const inside = (map: MapFile) => {
      let doors = 0;
      for (let y = 5; y <= 10; y++) {
        for (let x = 5; x <= 11; x++) {
          if (getStack(map, x, y, 0).at(-1)?.tileId === "door-closed") doors++;
        }
      }
      return doors;
    };
    expect(inside(built(of(true)))).toBe(2);
    expect(inside(built(of(false)))).toBe(0);
  });

  it("stocks containers with items that fit their slots and their piles, the same for the same seed", () => {
    const spec = (seed: number, stocked = true): BuildingSpec => ({
      floors: [storey("ground", { use: "storage", seed, stocked, doors: [FRONT_DOOR] })],
      cellars: [],
      roof: null,
    });
    const held = (map: MapFile) => {
      const out: string[] = [];
      for (let y = 5; y <= 10; y++) {
        for (let x = 5; x <= 11; x++) {
          for (const p of getStack(map, x, y, 0)) {
            if (!p.contents) continue;
            const size = { sack: 1, "crate-chest": 2 }[p.tileId];
            expect(size, p.tileId).toBeDefined();
            expect(p.contents.length).toBeLessThanOrEqual(size!);
            for (const item of p.contents) {
              const pile = (
                tilesById[item.tileId] as { interactions?: { item?: { pile?: number } } }
              ).interactions?.item?.pile;
              expect(item.count ?? 1, item.tileId).toBeLessThanOrEqual(pile ?? 1);
              out.push(`${x},${y}:${item.tileId}x${item.count ?? 1}`);
            }
          }
        }
      }
      return out;
    };
    const first = held(built(spec(21)));
    expect(first.length).toBeGreaterThan(0);
    expect(held(built(spec(21)))).toEqual(first);
    expect(held(built(spec(22)))).not.toEqual(first);
    expect(held(built(spec(21, false)))).toEqual([]);
  });

  it("builds the same building from the same seeds and a different one from another", () => {
    const a = planBuilding(lawn(20), tilesById, RECT, 0, tower("stairs", "pub", 4, 3));
    const b = planBuilding(lawn(20), tilesById, RECT, 0, tower("stairs", "pub", 4, 3));
    const c = planBuilding(lawn(20), tilesById, RECT, 0, tower("stairs", "pub", 9, 3));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
});
