import { describe, expect, it } from "vitest";
import tilesRaw from "../../data/tiles.json";
import { emptyMap, getStack, setStacks } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  MIN_FOREST_FOOTPRINT,
  MIN_GLADE_CELLS,
  growForest,
  planForest,
  type ForestConfig,
} from "./forest";
import {
  MAX_FOOTPRINT,
  gridIndex,
  newGrid,
  isOpen,
  regionsOf,
  type CellGrid,
  type Rect,
} from "./generator";

const tiles: TileDef[] = normalizeTiles(tilesRaw as unknown[]);
const tilesById = tilesByIdFromList(tiles);

const BASE: ForestConfig = {
  generator: "forest",
  seed: 8181,
  density: 55,
  groundTileId: "grass-2",
  treeTileId: "tree",
  paths: 1,
  pathWidth: 2,
  pathTileId: "dirt",
  waterTileId: null,
  waterCoverage: 0,
  scatter: [],
};

const RECT: Rect = { x0: -6, y0: 4, x1: 27, y1: 33 };
const BOUNDS = { minX: RECT.x0, maxX: RECT.x1, minY: RECT.y0, maxY: RECT.y1 };

function build(rect: Rect, config: Partial<ForestConfig> = {}, z = 0): MapFile {
  const plan = planForest(emptyMap(), tilesById, rect, z, { ...BASE, ...config });
  if (!plan.ok) throw new Error(plan.reason);
  return setStacks(emptyMap(), plan.edits);
}

function ids(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

function eachCell(rect: Rect, visit: (x: number, y: number) => void): void {
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) visit(x, y);
  }
}

/** Whether every cell you can walk on is part of some fully clear 2x2 square. */
function everyGapTwoWide(g: CellGrid): boolean {
  for (let y = g.minY; y < g.minY + g.height; y++) {
    for (let x = g.minX; x < g.minX + g.width; x++) {
      if (!isOpen(g, x, y)) continue;
      const inSquare = [
        [0, 0],
        [-1, 0],
        [0, -1],
        [-1, -1],
      ].some(
        ([ox, oy]) =>
          isOpen(g, x + ox!, y + oy!) &&
          isOpen(g, x + ox! + 1, y + oy!) &&
          isOpen(g, x + ox!, y + oy! + 1) &&
          isOpen(g, x + ox! + 1, y + oy! + 1),
      );
      if (!inSquare) return false;
    }
  }
  return true;
}

/** Mean share of cells holding a tree within `band` of the rectangle's edge. */
function treeShare(
  g: CellGrid,
  keep: (x: number, y: number) => boolean,
): number {
  let cells = 0;
  let trees = 0;
  for (let y = g.minY; y < g.minY + g.height; y++) {
    for (let x = g.minX; x < g.minX + g.width; x++) {
      if (!keep(x, y)) continue;
      cells++;
      if (!isOpen(g, x, y)) trees++;
    }
  }
  return cells === 0 ? 0 : trees / cells;
}

describe("growForest", () => {
  /** Cells from every cell to the nearest path cell, by orthogonal steps. */
  function pathDistance(grid: CellGrid, path: ReadonlySet<number>): Int32Array {
    const distance = new Int32Array(grid.cells.length).fill(-1);
    const queue = [...path];
    for (const i of queue) distance[i] = 0;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = (i % grid.width) + grid.minX;
      const y = Math.floor(i / grid.width) + grid.minY;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx!;
        const ny = y + dy!;
        if (
          nx < grid.minX ||
          ny < grid.minY ||
          nx >= grid.minX + grid.width ||
          ny >= grid.minY + grid.height
        ) {
          continue;
        }
        const j = (ny - grid.minY) * grid.width + (nx - grid.minX);
        if (distance[j] !== -1) continue;
        distance[j] = distance[i]! + 1;
        queue.push(j);
      }
    }
    return distance;
  }

  it("thins the trees out towards the path and thickens them away from it", () => {
    const { grid, path } = growForest(BOUNDS, BASE);
    const distance = pathDistance(grid, path);
    const at = (lo: number, hi: number) => (x: number, y: number) => {
      const d = distance[gridIndex(grid, x, y)] ?? 0;
      return d >= lo && d < hi;
    };
    expect(treeShare(grid, at(1, 4))).toBeLessThan(treeShare(grid, at(4, 9)));
    expect(treeShare(grid, at(4, 9))).toBeLessThan(treeShare(grid, at(9, 99)));
  });

  it("varies how thick the wood is from place to place, not just by the edges", () => {
    // Measured only where the path is far enough away to have stopped mattering,
    // so what is left is the thicket and clump fields. A wood whose density is
    // one number plus a border term comes out flat here.
    for (const seed of [1, 2, 3, 4]) {
      const { grid, path } = growForest(BOUNDS, { ...BASE, seed });
      const distance = pathDistance(grid, path);
      const shares: number[] = [];
      for (let y = BOUNDS.minY; y + 3 <= BOUNDS.maxY; y += 4) {
        for (let x = BOUNDS.minX; x + 3 <= BOUNDS.maxX; x += 4) {
          const window = (cx: number, cy: number) =>
            cx >= x && cx < x + 4 && cy >= y && cy < y + 4;
          let far = 0;
          for (let cy = y; cy < y + 4; cy++) {
            for (let cx = x; cx < x + 4; cx++) {
              if ((distance[gridIndex(grid, cx, cy)] ?? 0) >= 12) far++;
            }
          }
          if (far < 16) continue;
          shares.push(treeShare(grid, window));
        }
      }
      expect(shares.length).toBeGreaterThan(3);
      expect(Math.max(...shares) - Math.min(...shares)).toBeGreaterThan(0.35);
    }
  });

  it("does not run every path the same way", () => {
    // A path plotted as an offset from a straight crossing always makes
    // monotone progress along one axis, which is a wood with a stripe through
    // it. Over a spread of seeds both axes have to turn up.
    const axes = new Set<string>();
    for (let seed = 0; seed < 8; seed++) {
      const { grid, path } = growForest(BOUNDS, { ...BASE, seed });
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const i of path) {
        const x = (i % grid.width) + grid.minX;
        const y = Math.floor(i / grid.width) + grid.minY;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      axes.add(maxX - minX > maxY - minY ? "east-west" : "north-south");
    }
    expect(axes.size).toBe(2);
  });

  it("never leaves a gap one cell wide between trees", () => {
    for (const density of [10, 40, 70, 100]) {
      for (let seed = 0; seed < 6; seed++) {
        const { grid } = growForest(BOUNDS, { ...BASE, density, seed });
        expect(everyGapTwoWide(grid)).toBe(true);
      }
    }
  });

  it("cuts a track to every glade big enough to be worth one", () => {
    // Smaller ones are left unreachable on purpose: a hollow in a thicket you
    // cannot quite get into is a thicket, and planting them over is what turned
    // the far half of a dense wood into one solid block.
    for (const paths of [1, 2, 3]) {
      for (let seed = 0; seed < 6; seed++) {
        const { grid, path } = growForest(BOUNDS, { ...BASE, paths, seed });
        for (const region of regionsOf(grid)) {
          if (region.length < MIN_GLADE_CELLS) continue;
          expect(region.some((i) => path.has(i))).toBe(true);
        }
      }
    }
  });

  it("dithers the trees out at the edge rather than stopping them dead", () => {
    // Thinner at the very edge than a few cells in, but not bare: a ring of
    // empty ground is the rectangle showing through as plainly as a wall of
    // trees would.
    const { grid } = growForest(BOUNDS, { ...BASE, density: 80 });
    const ring = (lo: number, hi: number) => (x: number, y: number) => {
      const d = Math.min(
        x - BOUNDS.minX,
        BOUNDS.maxX - x,
        y - BOUNDS.minY,
        BOUNDS.maxY - y,
      );
      return d >= lo && d <= hi;
    };
    const edge = treeShare(grid, ring(0, 1));
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(treeShare(grid, ring(6, 99)));
  });

  it("runs each path from one edge of the rectangle to the other", () => {
    const { grid, path } = growForest(BOUNDS, BASE);
    const onEdge = [...path].filter((i) => {
      const x = (i % grid.width) + grid.minX;
      const y = Math.floor(i / grid.width) + grid.minY;
      return (
        x === BOUNDS.minX ||
        x === BOUNDS.maxX ||
        y === BOUNDS.minY ||
        y === BOUNDS.maxY
      );
    });
    // Both ends, so there is a way in and a way out.
    expect(onEdge.length).toBeGreaterThanOrEqual(2 * BASE.pathWidth);
  });

  it("plants more of the wood the higher the density", () => {
    const sparse = growForest(BOUNDS, { ...BASE, density: 20 });
    const thick = growForest(BOUNDS, { ...BASE, density: 90 });
    expect(treeShare(thick.grid, () => true)).toBeGreaterThan(
      treeShare(sparse.grid, () => true),
    );
  });
});

describe("planForest", () => {
  it("refuses a rectangle too small to hold a wood", () => {
    const plan = planForest(
      emptyMap(),
      tilesById,
      { x0: 0, y0: 0, x1: MIN_FOREST_FOOTPRINT - 2, y1: 20 },
      0,
      BASE,
    );
    expect(!plan.ok && plan.reason).toContain(`${MIN_FOREST_FOOTPRINT}`);
  });

  it("refuses an accidental drag across the world", () => {
    const plan = planForest(
      emptyMap(),
      tilesById,
      { x0: 0, y0: 0, x1: MAX_FOOTPRINT, y1: 10 },
      0,
      BASE,
    );
    expect(!plan.ok && plan.reason).toContain("at most");
  });

  it("lays the ground under every cell of the rectangle", () => {
    const map = build(RECT);
    let cells = 0;
    eachCell(RECT, (x, y) => {
      expect(ids(map, x, y)[0]).toBe("grass-2");
      cells++;
    });
    expect(cells).toBe(
      (RECT.x1 - RECT.x0 + 1) * (RECT.y1 - RECT.y0 + 1),
    );
  });

  it("lays the path on top of the ground rather than instead of it", () => {
    const map = build(RECT, { pathTileId: "cobblestone" });
    const { path, grid } = growForest(BOUNDS, BASE);
    let floored = 0;
    eachCell(RECT, (x, y) => {
      if (!path.has(gridIndex(grid, x, y))) return;
      expect(ids(map, x, y).slice(0, 2)).toEqual(["grass-2", "cobblestone"]);
      floored++;
    });
    expect(floored).toBeGreaterThan(0);
  });

  it("leaves the path as a clearing when it is given no tile", () => {
    const map = build(RECT, { pathTileId: null });
    const { path, grid } = growForest(BOUNDS, BASE);
    for (const i of path) {
      const x = (i % grid.width) + grid.minX;
      const y = Math.floor(i / grid.width) + grid.minY;
      expect(ids(map, x, y)).toEqual(["grass-2"]);
    }
  });

  it("never puts a tree on a path", () => {
    const map = build(RECT);
    const { path, grid } = growForest(BOUNDS, BASE);
    for (const i of path) {
      const x = (i % grid.width) + grid.minX;
      const y = Math.floor(i / grid.width) + grid.minY;
      expect(ids(map, x, y)).not.toContain("tree");
    }
  });

  it("refuses a tree too tall to stand on the ground and its path", () => {
    // A four-unit tree on a two-unit floor is six units into a level of four.
    const plan = planForest(emptyMap(), tilesById, RECT, 0, {
      ...BASE,
      groundTileId: "half-stone",
    });
    expect(!plan.ok && plan.reason).toContain("past the 4");
  });

  it("cuts the water's channel through the trees", () => {
    const config = { ...BASE, waterTileId: "water", waterCoverage: 25 };
    const dry = growForest(BOUNDS, config);
    const map = build(RECT, config);
    let felled = 0;
    eachCell(RECT, (x, y) => {
      if (isOpen(dry.grid, x, y)) return;
      const stack = ids(map, x, y);
      if (!stack.includes("water")) return;
      expect(stack).not.toContain("tree");
      felled++;
    });
    expect(felled).toBeGreaterThan(0);
  });

  it("does not let the water strand any part of the wood the path reaches", () => {
    for (const coverage of [10, 40]) {
      const config = { ...BASE, waterTileId: "water", waterCoverage: coverage };
      const map = build(RECT, config);
      const { path } = growForest(BOUNDS, config);
      const grid = newGrid(BOUNDS);
      const walkable = new Uint8Array(grid.cells.length);
      eachCell(RECT, (x, y) => {
        const stack = ids(map, x, y);
        const i = gridIndex(grid, x, y);
        grid.cells[i] = stack.includes("tree") ? 0 : 1;
        walkable[i] = stack.includes("tree") || stack.includes("water") ? 0 : 1;
      });
      // The wood keeps its unreachable hollows, so what has to hold is that
      // everything the path could reach before the streams it can still reach.
      const reached = regionsOf(grid, walkable).filter((region) =>
        region.some((i) => path.has(i)),
      );
      expect(reached).toHaveLength(1);
      expect(reached[0]!.length).toBeGreaterThan(100);
    }
  });

  it("scatters undergrowth between the trees, never on a path", () => {
    const map = build(RECT, {
      scatter: [{ tileId: "small-bush", chancePercent: 25 }],
    });
    const { path, grid } = growForest(BOUNDS, BASE);
    let bushes = 0;
    eachCell(RECT, (x, y) => {
      if (!ids(map, x, y).includes("small-bush")) return;
      expect(path.has(gridIndex(grid, x, y))).toBe(false);
      expect(ids(map, x, y)).not.toContain("tree");
      bushes++;
    });
    expect(bushes).toBeGreaterThan(0);
  });

  it("grows the same wood from the same seed and a different one from another", () => {
    const one = planForest(emptyMap(), tilesById, RECT, 0, BASE);
    const same = planForest(emptyMap(), tilesById, RECT, 0, BASE);
    const other = planForest(emptyMap(), tilesById, RECT, 0, { ...BASE, seed: 5 });
    expect(one.ok && same.ok && one.edits).toEqual(same.ok && same.edits);
    expect(one.ok && other.ok && one.edits).not.toEqual(other.ok && other.edits);
  });

  it("refuses to grow over somebody standing in it", () => {
    const occupied = setStacks(emptyMap(), [
      { x: 0, y: 10, z: 0, stack: [{ tileId: "grass-2" }, { tileId: "deer" }] },
    ]);
    const plan = planForest(occupied, tilesById, RECT, 0, BASE);
    expect(!plan.ok && plan.reason).toContain("standing at 0,10");
  });
});
