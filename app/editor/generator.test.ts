import { describe, expect, it } from "vitest";
import tilesRaw from "../../data/tiles.json";
import { emptyMap, setStacks } from "../lib/mapData";
import type { TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  columnOf,
  connectionsAlongBorder,
  cutFords,
  gridIndex,
  isJoinableGround,
  isOpen,
  newGrid,
  openConnection,
  planScatter,
  planWater,
  regionsOf,
  setOpen,
  widenToTwo,
  type CellGrid,
} from "./generator";

const tiles: TileDef[] = normalizeTiles(tilesRaw as unknown[]);
const tilesById = tilesByIdFromList(tiles);

/** A grid from rows of text: `.` is open, anything else is not. */
function gridOf(rows: string[]): CellGrid {
  const g = newGrid({
    minX: 0,
    maxX: rows[0]!.length - 1,
    minY: 0,
    maxY: rows.length - 1,
  });
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => setOpen(g, x, y, cell === "."));
  });
  return g;
}

function rowsOf(g: CellGrid): string[] {
  const rows: string[] = [];
  for (let y = g.minY; y < g.minY + g.height; y++) {
    let row = "";
    for (let x = g.minX; x < g.minX + g.width; x++) {
      row += isOpen(g, x, y) ? "." : "#";
    }
    rows.push(row);
  }
  return rows;
}

describe("columnOf", () => {
  it("stacks a tile to fill the height exactly", () => {
    const column = columnOf("half-stone", 4, tilesById);
    expect(column.ok && column.stack).toEqual([
      { tileId: "half-stone" },
      { tileId: "half-stone" },
    ]);
  });

  it("takes one tile when one is the whole level", () => {
    const column = columnOf("stone-wall", 4, tilesById);
    expect(column.ok && column.stack).toEqual([{ tileId: "stone-wall" }]);
  });

  it("refuses a tile that does not divide the height, rather than rounding", () => {
    // `rat` is one unit tall; four of them would fill a level, but a column of
    // rats is not the point — the refusal names the arithmetic.
    const column = columnOf("player", 4, tilesById);
    expect(column.ok).toBe(false);
    expect(!column.ok && column.reason).toContain("3 units");
  });

  it("refuses a flat tile outright", () => {
    const column = columnOf("grass", 4, tilesById);
    expect(!column.ok && column.reason).toContain("flat");
  });
});

describe("widenToTwo", () => {
  it("closes a corridor one cell wide", () => {
    const g = gridOf([
      "########",
      "##....##",
      "##....##",
      "###.####",
      "##....##",
      "##....##",
      "########",
    ]);
    widenToTwo(g);
    // The neck is gone; the two rooms either side of it are untouched.
    expect(rowsOf(g)).toEqual([
      "########",
      "##....##",
      "##....##",
      "########",
      "##....##",
      "##....##",
      "########",
    ]);
  });

  it("keeps a corridor two cells wide", () => {
    const rows = [
      "########",
      "##....##",
      "##....##",
      "###..###",
      "###..###",
      "##....##",
      "##....##",
      "########",
    ];
    const g = gridOf(rows);
    widenToTwo(g);
    expect(rowsOf(g)).toEqual(rows);
  });

  it("runs to a fixed point, so filling one neck exposing another closes both", () => {
    // A spur off a spur: taking the tip out leaves the stem one wide too.
    const g = gridOf([
      "######",
      "#..###",
      "#..###",
      "#.####",
      "#.####",
      "######",
    ]);
    widenToTwo(g);
    expect(rowsOf(g)).toEqual([
      "######",
      "#..###",
      "#..###",
      "######",
      "######",
      "######",
    ]);
  });
});

describe("planWater and cutFords", () => {
  /** A room with a two-wide waist, which is the narrowest a cave ever has. */
  const HOURGLASS = [
    "########",
    "#......#",
    "#......#",
    "###..###",
    "###..###",
    "#......#",
    "#......#",
    "########",
  ];

  /** The whole 8x8 fixture, so the water may go anywhere in it. */
  const WHOLE_GRID = { minX: 0, maxX: 7, minY: 0, maxY: 7 };

  it("dries a crossing wherever water would seal a passage", () => {
    const g = gridOf(HOURGLASS);
    // Flood the whole waist: without a ford the two halves are separate.
    const water = new Set(
      [3, 4].flatMap((y) => [3, 4].map((x) => gridIndex(g, x, y))),
    );
    cutFords(g, water);

    const dry = new Uint8Array(g.cells);
    for (const i of water) dry[i] = 0;
    expect(regionsOf(g, dry)).toHaveLength(1);
    // And it took the least it could: three of the four waist cells are wet.
    expect(water.size).toBe(2);
  });

  it("leaves water alone when the floor is still one piece without it", () => {
    const g = gridOf(HOURGLASS);
    const water = new Set([gridIndex(g, 1, 1), gridIndex(g, 2, 1)]);
    cutFords(g, water);
    expect(water.size).toBe(2);
  });

  it("keeps the floor walkable at every coverage it is asked for", () => {
    for (const coverage of [5, 25, 60, 100]) {
      const g = gridOf(HOURGLASS);
      const water = planWater(g, WHOLE_GRID, 99, coverage);
      for (const i of water) g.cells[i] = 1;
      cutFords(g, water);
      const dry = new Uint8Array(g.cells);
      for (const i of water) dry[i] = 0;
      expect(regionsOf(g, dry).length).toBeLessThanOrEqual(1);
    }
  });

  it("puts down no water at all when asked for none", () => {
    const g = gridOf(HOURGLASS);
    expect(planWater(g, WHOLE_GRID, 1, 0).size).toBe(0);
  });

  it("cuts its channel through the rock rather than staying on the floor", () => {
    // A room with rock all round it: at this coverage the streams have to
    // leave it, and every cell they take is one the caller then opens.
    const g = gridOf(HOURGLASS);
    const water = planWater(g, WHOLE_GRID, 5, 60);
    const eroded = [...water].filter((i) => g.cells[i] === 0);
    expect(eroded.length).toBeGreaterThan(0);
  });

  it("never erodes outside the area it is given", () => {
    const g = gridOf(HOURGLASS);
    const inner = { minX: 1, maxX: 6, minY: 1, maxY: 6 };
    for (const i of planWater(g, inner, 3, 80)) {
      const x = (i % g.width) + g.minX;
      const y = Math.floor(i / g.width) + g.minY;
      expect(x).toBeGreaterThanOrEqual(inner.minX);
      expect(x).toBeLessThanOrEqual(inner.maxX);
      expect(y).toBeGreaterThanOrEqual(inner.minY);
      expect(y).toBeLessThanOrEqual(inner.maxY);
    }
  });
});

describe("planScatter", () => {
  const cells = Array.from({ length: 400 }, (_, i) => ({
    x: i % 20,
    y: Math.floor(i / 20),
  }));

  it("gives a cell at most one prop, the earlier rule winning", () => {
    const scatter = planScatter(
      cells,
      [
        { tileId: "small-bush", chancePercent: 100 },
        { tileId: "berry", chancePercent: 100 },
      ],
      7,
      0,
      tilesById,
    );
    expect(scatter.size).toBe(cells.length);
    expect([...new Set(scatter.values())]).toEqual(["small-bush"]);
  });

  it("lands roughly as often as it is asked to", () => {
    const scatter = planScatter(
      cells,
      [{ tileId: "small-bush", chancePercent: 25 }],
      7,
      0,
      tilesById,
    );
    expect(scatter.size).toBeGreaterThan(cells.length * 0.15);
    expect(scatter.size).toBeLessThan(cells.length * 0.35);
  });

  it("drops a prop too tall to stand on the floor it is given", () => {
    // A four-unit tree on a two-unit floor is five units into a level of four.
    const onFlat = planScatter(
      cells,
      [{ tileId: "tree", chancePercent: 100 }],
      7,
      0,
      tilesById,
    );
    expect(onFlat.size).toBe(cells.length);
    const onPlinth = planScatter(
      cells,
      [{ tileId: "tree", chancePercent: 100 }],
      7,
      2,
      tilesById,
    );
    expect(onPlinth.size).toBe(0);
  });

  it("leaves the other props where they were when one changes frequency", () => {
    const rules = [
      { tileId: "small-bush", chancePercent: 20 },
      { tileId: "berry", chancePercent: 20 },
    ];
    const before = planScatter(cells, rules, 7, 0, tilesById);
    const after = planScatter(
      cells,
      [rules[0]!, { tileId: "berry", chancePercent: 40 }],
      7,
      0,
      tilesById,
    );
    for (const [key, tileId] of before) {
      if (tileId !== "small-bush") continue;
      expect(after.get(key)).toBe("small-bush");
    }
  });
});

describe("connectionsAlongBorder", () => {
  const BOUNDS = { minX: 0, maxX: 9, minY: 0, maxY: 9 };

  it("gives one way in per run, at its middle", () => {
    // Ground along the west side, outside cells (-1, 2) to (-1, 6).
    const joinable = (x: number, y: number) => x === -1 && y >= 2 && y <= 6;
    const found = connectionsAlongBorder(BOUNDS, joinable);
    expect(found).toEqual([
      { x: 0, y: 4, inward: { dx: 1, dy: 0 } },
    ]);
  });

  it("gives each run of ground its own way in", () => {
    const joinable = (x: number, y: number) =>
      y === -1 && ((x >= 1 && x <= 3) || (x >= 7 && x <= 8));
    const found = connectionsAlongBorder(BOUNDS, joinable);
    expect(found.map((c) => c.x)).toEqual([2, 7]);
    expect(found.every((c) => c.y === 0 && c.inward.dy === 1)).toBe(true);
  });

  it("finds nothing when the rectangle stands on its own", () => {
    expect(connectionsAlongBorder(BOUNDS, () => false)).toEqual([]);
  });
});

describe("isJoinableGround", () => {
  const map = setStacks(emptyMap(), [
    { x: 0, y: 0, z: 0, stack: [{ tileId: "dirt" }] },
    // A cave's rock stands on the same floor its cave does.
    { x: 1, y: 0, z: 0, stack: [{ tileId: "dirt" }, { tileId: "half-stone" }, { tileId: "half-stone" }] },
    { x: 2, y: 0, z: 0, stack: [{ tileId: "dirt" }, { tileId: "small-bush" }] },
    { x: 3, y: 0, z: 0, stack: [{ tileId: "dirt" }, { tileId: "water" }] },
    { x: 4, y: 0, z: 0, stack: [{ tileId: "grass-2" }] },
  ]);
  const joinable = isJoinableGround(map, tilesById, 0, ["dirt"]);

  it("takes bare floor of its own kind", () => {
    expect(joinable(0, 0)).toBe(true);
  });

  it("refuses a wall standing on that floor", () => {
    expect(joinable(1, 0)).toBe(false);
  });

  it("refuses floor with something on it", () => {
    expect(joinable(2, 0)).toBe(false);
    expect(joinable(3, 0)).toBe(false);
  });

  it("refuses ground of another kind, and nothing at all", () => {
    expect(joinable(4, 0)).toBe(false);
    expect(joinable(9, 9)).toBe(false);
  });
});

describe("openConnection", () => {
  it("cuts two cells wide, and stops where it meets open ground", () => {
    const g = gridOf([
      "########",
      "########",
      "##....##",
      "##....##",
      "########",
      "########",
    ]);
    openConnection(
      g,
      { minX: 0, maxX: 7, minY: 0, maxY: 5 },
      { x: 0, y: 2, inward: { dx: 1, dy: 0 } },
      6,
    );
    expect(rowsOf(g)).toEqual([
      "########",
      "########",
      "......##",
      "......##",
      "########",
      "########",
    ]);
  });

  it("stops at the depth it is given when it meets nothing", () => {
    // `maxDepth` counts steps inward, and the brush is two cells deep, so two
    // steps reach four cells in.
    const g = gridOf([
      "######",
      "######",
      "######",
      "######",
    ]);
    openConnection(
      g,
      { minX: 0, maxX: 5, minY: 0, maxY: 3 },
      { x: 0, y: 1, inward: { dx: 1, dy: 0 } },
      2,
    );
    expect(rowsOf(g)).toEqual([
      "######",
      "....##",
      "....##",
      "######",
    ]);
  });
});
