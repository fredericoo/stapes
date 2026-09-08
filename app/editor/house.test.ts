import { describe, expect, it } from "vitest";
import tilesRaw from "../../data/tiles.json";
import { emptyMap, getStack, setStacks } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  MIN_FOOTPRINT,
  doorSpotFor,
  planHouse,
  roofLevelsFor,
  windowsAlong,
  type HouseConfig,
} from "./house";

const tiles: TileDef[] = normalizeTiles(tilesRaw as unknown[]);
const tilesById = tilesByIdFromList(tiles);

const BASE: HouseConfig = {
  storeys: 1,
  roofOrientation: "vertical",
  roofColour: "red",
  wallTileId: "sw2",
  floorTileId: "wooden-floor",
  windowTileId: "window-1",
  windowSpacing: 2,
  doorTileId: "door-closed",
  doorRow: "south",
  doorColumn: "centre",
};

/** A flat site of `tileId` over the given box, so a house has ground to stand on. */
function siteMap(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stack: PlacedTile[] = [{ tileId: "grass-2" }],
): MapFile {
  const edits = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      edits.push({ x, y, z: 0, stack: stack.map((p) => ({ ...p })) });
    }
  }
  return setStacks(emptyMap(), edits);
}

function build(
  map: MapFile,
  rect: { x0: number; y0: number; x1: number; y1: number },
  config: Partial<HouseConfig> = {},
  z = 0,
): MapFile {
  const plan = planHouse(map, tilesById, rect, z, { ...BASE, ...config });
  if (!plan.ok) throw new Error(plan.reason);
  return setStacks(map, plan.edits);
}

function ids(map: MapFile, x: number, y: number, z: number): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

function facing(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): string | undefined {
  const stack = getStack(map, x, y, z);
  return stack[stack.length - 1]?.direction;
}

describe("roofLevelsFor", () => {
  it("steps in one cell a side until the span runs out", () => {
    // 5 → 5, 3, 1 (the cottage); 6 → 6, 4, 2 (the shop).
    expect(roofLevelsFor(5)).toBe(3);
    expect(roofLevelsFor(6)).toBe(3);
    expect(roofLevelsFor(4)).toBe(2);
    expect(roofLevelsFor(3)).toBe(2);
    expect(roofLevelsFor(2)).toBe(1);
    expect(roofLevelsFor(1)).toBe(1);
  });
});

describe("doorSpotFor", () => {
  const bounds = { minX: 0, maxX: 8, minY: 0, maxY: 8 };

  it("puts a cardinal door in the middle of the wall its row or column names", () => {
    expect(doorSpotFor(bounds, "south", "centre")).toEqual({
      x: 4,
      y: 8,
      wall: "s",
    });
    expect(doorSpotFor(bounds, "north", "centre")).toEqual({
      x: 4,
      y: 0,
      wall: "n",
    });
    expect(doorSpotFor(bounds, "centre", "west")).toEqual({
      x: 0,
      y: 4,
      wall: "w",
    });
    expect(doorSpotFor(bounds, "centre", "east")).toEqual({
      x: 8,
      y: 4,
      wall: "e",
    });
  });

  it("lets the row pick the wall and the column pick the end of it", () => {
    expect(doorSpotFor(bounds, "north", "west")).toEqual({
      x: 2,
      y: 0,
      wall: "n",
    });
    expect(doorSpotFor(bounds, "south", "east")).toEqual({
      x: 6,
      y: 8,
      wall: "s",
    });
  });

  it("has no wall to put a door on when both coordinates are centred", () => {
    expect(doorSpotFor(bounds, "centre", "centre")).toBeNull();
  });

  it("centres the door of a five-wide wall, as the cottage's is", () => {
    const cottage = { minX: 12, maxX: 16, minY: 3, maxY: 7 };
    expect(doorSpotFor(cottage, "centre", "west")).toEqual({
      x: 12,
      y: 5,
      wall: "w",
    });
  });

  it("refuses a wall too short to keep the door clear of both corners", () => {
    const small = { minX: 0, maxX: 3, minY: 0, maxY: 3 };
    expect(doorSpotFor(small, "south", "centre")).toBeNull();
  });
});

describe("windowsAlong", () => {
  it("keeps clear of the corners and steps by the spacing it is given", () => {
    expect(windowsAlong(0, 8, null, 2)).toEqual([1, 3, 5, 7]);
    expect(windowsAlong(0, 8, null, 3)).toEqual([1, 4, 7]);
    expect(windowsAlong(0, 8, null, 4)).toEqual([2, 6]);
  });

  it("centres what fits rather than crowding it against one corner", () => {
    expect(windowsAlong(0, 10, null, 6)).toEqual([2, 8]);
    expect(windowsAlong(0, 10, null, 12)).toEqual([5]);
  });

  it("puts the cell it cannot divide evenly in the middle, not at the far end", () => {
    // Wall cells 1…9. Two windows five apart leave three over: one at each
    // margin and one widening the gap between them.
    expect(windowsAlong(0, 10, null, 5)).toEqual([2, 8]);
    // Three windows three apart on cells 1…8 leave one over, and it goes
    // inside rather than leaving cell 8 blank against the corner.
    expect(windowsAlong(0, 9, null, 3)).toEqual([1, 4, 8]);
  });

  it("leaves the same margin at both ends of every wall it can fill", () => {
    for (let wall = 3; wall <= 40; wall++) {
      for (let spacing = 2; spacing <= 8; spacing++) {
        const at = windowsAlong(0, wall - 1, null, spacing);
        if (at.length === 0) continue;
        const before = at[0]! - 1;
        const after = wall - 2 - at[at.length - 1]!;
        // A lone window has no middle gap to absorb an odd cell, so on a wall
        // with an even number of usable cells it has no symmetric home and
        // sits one short of the middle. Everything else matches exactly.
        const slop = at.length === 1 ? 1 : 0;
        expect({ wall, spacing, off: Math.abs(before - after) <= slop }).toEqual(
          { wall, spacing, off: true },
        );
      }
    }
  });

  it("leaves a wall cell between a window and the door", () => {
    expect(windowsAlong(0, 8, 4, 2)).toEqual([1, 7]);
  });

  it("has nowhere to put one on a wall three cells long", () => {
    expect(windowsAlong(0, 2, null, 2)).toEqual([1]);
    expect(windowsAlong(0, 1, null, 2)).toEqual([]);
  });

  it("never packs windows tighter than the range's floor", () => {
    expect(windowsAlong(0, 8, null, 1)).toEqual(windowsAlong(0, 8, null, 2));
  });
});

describe("planHouse", () => {
  it("refuses a footprint with no inside", () => {
    const map = siteMap(-2, -2, 10, 10);
    const plan = planHouse(map, tilesById, { x0: 0, y0: 0, x1: 1, y1: 1 }, 0, BASE);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain(String(MIN_FOOTPRINT));
  });

  it("lays the ground floor on the site rather than in place of it", () => {
    const map = siteMap(-2, -2, 10, 10, [
      { tileId: "grass-2" },
      { tileId: "cobblestone" },
    ]);
    const built = build(map, { x0: 0, y0: 0, x1: 4, y1: 4 });

    expect(ids(built, 0, 0, 0)).toEqual([
      "grass-2",
      "cobblestone",
      "wooden-floor",
      "sw2",
    ]);
    expect(ids(built, 2, 2, 0)).toEqual([
      "grass-2",
      "cobblestone",
      "wooden-floor",
    ]);
  });

  it("refuses a site that is not level", () => {
    const map = setStacks(siteMap(-2, -2, 10, 10), [
      { x: 2, y: 2, z: 0, stack: [{ tileId: "grass-2" }, { tileId: "tree" }] },
    ]);
    const plan = planHouse(map, tilesById, { x0: 0, y0: 0, x1: 4, y1: 4 }, 0, BASE);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("not level");
  });

  it("builds on a level plinth when the walls still fit a level", () => {
    const map = siteMap(-2, -2, 10, 10, [
      { tileId: "dirt" },
      { tileId: "half-stone" },
    ]);
    const built = build(map, { x0: 0, y0: 0, x1: 4, y1: 4 }, {
      wallTileId: "half-wall",
      windowTileId: null,
      doorTileId: null,
    });
    expect(ids(built, 0, 0, 0)).toEqual([
      "dirt",
      "half-stone",
      "wooden-floor",
      "half-wall",
    ]);
  });

  it("says so when the site plus a full-height wall is taller than a level", () => {
    const map = siteMap(-2, -2, 10, 10, [
      { tileId: "dirt" },
      { tileId: "half-stone" },
    ]);
    const plan = planHouse(map, tilesById, { x0: 0, y0: 0, x1: 4, y1: 4 }, 0, BASE);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("past the 4 a level holds");
  });

  it("refuses outright when anything at all stands above the footprint", () => {
    const map = setStacks(siteMap(-2, -2, 10, 10), [
      { x: 3, y: 3, z: 1, stack: [{ tileId: "roof-1", direction: "s" }] },
    ]);
    const plan = planHouse(map, tilesById, { x0: 0, y0: 0, x1: 4, y1: 4 }, 0, BASE);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("3,3");
  });

  it("refuses to build over anybody standing on the site", () => {
    const map = setStacks(siteMap(-2, -2, 10, 10), [
      { x: 2, y: 2, z: 0, stack: [{ tileId: "grass-2" }, { tileId: "rat" }] },
    ]);
    const plan = planHouse(map, tilesById, { x0: 0, y0: 0, x1: 4, y1: 4 }, 0, BASE);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("standing");
  });

  it("roofs a five-wide vertical ridge the way the cottage is roofed", () => {
    const map = siteMap(-2, -2, 10, 10);
    const built = build(map, { x0: 0, y0: 0, x1: 4, y1: 4 }, {
      roofColour: "blue",
    });

    // West eave faces the ridge, east eave faces back at it, plaster between.
    expect(ids(built, 0, 2, 1)).toEqual(["roof-4"]);
    expect(facing(built, 0, 2, 1)).toBe("e");
    expect(ids(built, 4, 2, 1)).toEqual(["roof-4"]);
    expect(facing(built, 4, 2, 1)).toBe("w");
    expect(ids(built, 2, 2, 1)).toEqual(["plaster", "plaster"]);

    // One cell in on each side per level, and a cap where the span runs out.
    expect(ids(built, 1, 0, 2)).toEqual(["roof-4"]);
    expect(ids(built, 2, 0, 3)).toEqual(["roof-6"]);
    expect(facing(built, 2, 0, 3)).toBe("s");
    expect(getStack(built, 2, 2, 4)).toEqual([]);
  });

  it("turns the same roof through ninety degrees", () => {
    const map = siteMap(-2, -2, 10, 10);
    const built = build(map, { x0: 0, y0: 0, x1: 4, y1: 4 }, {
      roofOrientation: "horizontal",
    });

    expect(facing(built, 2, 0, 1)).toBe("s");
    expect(facing(built, 2, 4, 1)).toBe("n");
    expect(ids(built, 2, 2, 1)).toEqual(["plaster", "plaster"]);
    expect(ids(built, 2, 2, 3)).toEqual(["roof-3"]);
    expect(facing(built, 2, 2, 3)).toBe("e");
  });

  it("stacks storeys of wall and starts the roof above the top one", () => {
    const map = siteMap(-2, -2, 12, 12);
    const built = build(map, { x0: 0, y0: 0, x1: 6, y1: 6 }, { storeys: 2 });

    expect(ids(built, 0, 2, 1)).toEqual(["wooden-floor", "sw2"]);
    expect(ids(built, 3, 3, 1)).toEqual(["wooden-floor"]);
    expect(ids(built, 3, 3, 2)).toEqual(["plaster", "plaster"]);
  });

  it("faces the door out of the house", () => {
    const map = siteMap(-2, -2, 12, 12);
    const cases: Array<[HouseConfig["doorRow"], HouseConfig["doorColumn"], number, number, string]> = [
      ["north", "centre", 3, 0, "n"],
      ["south", "centre", 3, 6, "s"],
      ["centre", "west", 0, 3, "w"],
      ["centre", "east", 6, 3, "e"],
    ];
    for (const [doorRow, doorColumn, x, y, face] of cases) {
      const built = build(map, { x0: 0, y0: 0, x1: 6, y1: 6 }, {
        doorRow,
        doorColumn,
      });
      expect(ids(built, x, y, 0)).toContain("door-closed");
      expect(facing(built, x, y, 0)).toBe(face);
    }
  });

  it("only cuts a door into the ground floor", () => {
    const map = siteMap(-2, -2, 12, 12);
    const built = build(map, { x0: 0, y0: 0, x1: 6, y1: 6 }, { storeys: 2 });

    expect(ids(built, 3, 6, 0)).toContain("door-closed");
    // The wall above it is unbroken — a window may take the cell, a door never.
    expect(ids(built, 3, 6, 1)).not.toContain("door-closed");
  });

  it("faces a window at the visible side of the wall it is set into", () => {
    const map = siteMap(-2, -2, 12, 12);
    const built = build(map, { x0: 0, y0: 0, x1: 6, y1: 6 }, {
      doorTileId: null,
    });

    // An east-west wall shows its south face; a north-south wall its east one.
    expect(ids(built, 3, 0, 0)).toEqual(["grass-2", "wooden-floor", "window-1"]);
    expect(facing(built, 3, 0, 0)).toBe("s");
    expect(ids(built, 0, 3, 0)).toEqual(["grass-2", "wooden-floor", "window-1"]);
    expect(facing(built, 0, 3, 0)).toBe("e");
  });

  it("spaces windows by the setting rather than by a fixed number", () => {
    const map = siteMap(-2, -2, 12, 12);
    const tight = build(map, { x0: 0, y0: 0, x1: 10, y1: 10 }, {
      doorTileId: null,
      windowSpacing: 2,
    });
    const loose = build(map, { x0: 0, y0: 0, x1: 10, y1: 10 }, {
      doorTileId: null,
      windowSpacing: 5,
    });
    const northWindows = (m: MapFile) => {
      const out: number[] = [];
      for (let x = 0; x <= 10; x++) {
        if (ids(m, x, 0, 0).includes("window-1")) out.push(x);
      }
      return out;
    };
    expect(northWindows(tight)).toEqual([1, 3, 5, 7, 9]);
    expect(northWindows(loose)).toEqual([2, 8]);
  });

  it("leaves the walls blank when no window tile is chosen", () => {
    const map = siteMap(-2, -2, 12, 12);
    const built = build(map, { x0: 0, y0: 0, x1: 6, y1: 6 }, {
      windowTileId: null,
    });
    for (let x = 0; x <= 6; x++) {
      expect(ids(built, x, 0, 0)).not.toContain("window-1");
    }
  });

  it("never puts a window in a corner", () => {
    const map = siteMap(-2, -2, 12, 12);
    const built = build(map, { x0: 0, y0: 0, x1: 6, y1: 6 }, {
      doorTileId: null,
    });
    for (const [x, y] of [
      [0, 0],
      [6, 0],
      [0, 6],
      [6, 6],
    ]) {
      expect(ids(built, x!, y!, 0)).toEqual(["grass-2", "wooden-floor", "sw2"]);
    }
  });

  it("leaves the door out rather than crowding it into a small house", () => {
    const map = siteMap(-2, -2, 10, 10);
    const built = build(map, { x0: 0, y0: 0, x1: 3, y1: 3 });
    for (let x = 0; x <= 3; x++) {
      expect(ids(built, x, 3, 0)).not.toContain("door-closed");
    }
  });

  it("writes every cell once, so a commit is one undo", () => {
    const map = siteMap(-2, -2, 12, 12);
    const plan = planHouse(
      map,
      tilesById,
      { x0: 0, y0: 0, x1: 6, y1: 6 },
      0,
      BASE,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const seen = new Set(plan.edits.map((e) => `${e.z}:${e.x},${e.y}`));
    expect(seen.size).toBe(plan.edits.length);
  });
});
