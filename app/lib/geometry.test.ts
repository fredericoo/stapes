import { describe, expect, it } from "vitest";
import {
  absoluteElevation,
  boxSurfaceElevation,
  depthBox,
  drawOrder,
  fragDepth,
  PX_PER_HEIGHT,
} from "./geometry";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "./types";

/** Window depth is smaller = nearer, so "in front" means a lower value. */
function expectInFront(near: number, far: number) {
  expect(near).toBeLessThan(far);
}

/** Screen pixel where a cell's own foot corner lands (no elevation shift). */
function footPixel(cellX: number, cellY: number) {
  return { sx: cellX * CELL_SIZE, sy: cellY * CELL_SIZE };
}

describe("absoluteElevation", () => {
  it("combines level floor with in-stack elevation", () => {
    expect(absoluteElevation(0, 0)).toBe(0);
    expect(absoluteElevation(0, 2)).toBe(2);
    expect(absoluteElevation(1, 0)).toBe(HEIGHT_PER_LEVEL);
    expect(absoluteElevation(1, 1)).toBe(HEIGHT_PER_LEVEL + 1);
  });
});

describe("drawOrder", () => {
  it("lets east win over a taller western tile on the same row", () => {
    const westTall = drawOrder(5, 10, absoluteElevation(0, 3), 2);
    const eastRoof = drawOrder(6, 10, absoluteElevation(1, 0), 0);
    expect(eastRoof).toBeGreaterThan(westTall);
  });

  it("lets south win over a northern tile on a superior level", () => {
    const south = drawOrder(5, 10, absoluteElevation(0, 3), 2);
    const northRoof = drawOrder(5, 9, absoluteElevation(1, 0), 0);
    expect(south).toBeGreaterThan(northRoof);
  });

  it("orders same-cell stacks by absolute elevation across levels", () => {
    const lower = drawOrder(3, 3, absoluteElevation(0, 1), 0);
    const upper = drawOrder(3, 3, absoluteElevation(1, 0), 0);
    expect(upper).toBeGreaterThan(lower);
  });
});

describe("boxSurfaceElevation", () => {
  it("reads the top face over the middle of a flat tile", () => {
    const flat = depthBox(4, 4, 0, 0);
    const { sx, sy } = footPixel(4, 4);
    expect(boxSurfaceElevation(flat, sx + 4, sy + 4)).toBe(0);
  });

  it("climbs the east face as pixels move west across a tall tile", () => {
    const column = depthBox(4, 4, 0, 4);
    // Each height unit shifts a face PX_PER_HEIGHT px up-left, so pixels
    // sampled up-left along the face read progressively higher. Staying north
    // keeps the south face from being the nearer one.
    expect(boxSurfaceElevation(column, 40 - PX_PER_HEIGHT, 40 - 2 * PX_PER_HEIGHT)).toBe(1);
    expect(boxSurfaceElevation(column, 40 - 2 * PX_PER_HEIGHT, 40 - 3 * PX_PER_HEIGHT)).toBe(2);
  });

  it("caps at the top face and never dips below the foot", () => {
    const column = depthBox(4, 4, 1, 3);
    expect(boxSurfaceElevation(column, -1000, -1000)).toBe(3);
    // Art drawn outside the footprint (tree canopy) clamps to the foot plane.
    expect(boxSurfaceElevation(column, 1000, 1000)).toBe(1);
  });
});

describe("fragDepth", () => {
  /**
   * Cells one step down-right and HEIGHT_PER_LEVEL height units up project to
   * the very same pixels, so this is where sprites actually overlap and depth
   * has to decide.
   */
  it("puts a raised south-east tile in front of the ground tile it covers", () => {
    const ground = depthBox(5, 9, 0, 0);
    const roof = depthBox(6, 10, HEIGHT_PER_LEVEL, HEIGHT_PER_LEVEL);
    const sx = 44;
    const sy = 76;
    expectInFront(fragDepth(roof, sx, sy), fragDepth(ground, sx, sy));
  });

  it("puts a tall column's flank in front of the ground tile behind it", () => {
    const ground = depthBox(5, 9, 0, 0);
    const column = depthBox(6, 10, 0, 4);
    const sx = 44;
    const sy = 76;
    expectInFront(fragDepth(column, sx, sy), fragDepth(ground, sx, sy));
  });

  it("separates coplanar surfaces by stack bias", () => {
    // Dirt (h=0) and the player standing on it share the same foot plane.
    const cell = depthBox(0, 0, 0, 0);
    const player = depthBox(0, 0, 0, 2);
    const p = footPixel(0, 0);
    expectInFront(
      fragDepth(player, p.sx + 4, p.sy + 4, 1),
      fragDepth(cell, p.sx + 4, p.sy + 4, 0),
    );
  });

  it("stays inside the normalised depth range for extreme placements", () => {
    const far = depthBox(200, 200, absoluteElevation(8, 4), absoluteElevation(8, 6));
    const d = fragDepth(far, 200 * CELL_SIZE, 200 * CELL_SIZE, 16);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });

  /**
   * The case that motivated per-pixel depth. Mid-step the mover has to be
   * behind the tall stack beside it AND in front of the floor it is stepping
   * onto — two orderings no single depth value per sprite can hold at once.
   */
  it("keeps a mid-walk mover behind the east stack and above the destination floor", () => {
    const col = 5;
    const row = 10;
    const eastStack = depthBox(col + 1, row, 0, 4);
    const destFloor = depthBox(col, row + 1, 0, 0);
    const mover = depthBox(col, row + 0.5, 0, 2);
    const moverBias = 1;

    // A pixel on the east stack's west flank, level with the mover's row.
    const againstStack = {
      sx: (col + 1) * CELL_SIZE + 1,
      sy: row * CELL_SIZE + 4,
    };
    expectInFront(
      fragDepth(eastStack, againstStack.sx, againstStack.sy),
      fragDepth(mover, againstStack.sx, againstStack.sy, moverBias),
    );

    // A pixel over the destination floor, where the mover's feet are landing.
    const overFloor = {
      sx: col * CELL_SIZE + 4,
      sy: (row + 1) * CELL_SIZE + 2,
    };
    expectInFront(
      fragDepth(mover, overFloor.sx, overFloor.sy, moverBias),
      fragDepth(destFloor, overFloor.sx, overFloor.sy),
    );
  });
});
