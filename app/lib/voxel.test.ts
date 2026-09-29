import { describe, expect, it } from "vitest";
import {
  emptyGrid,
  gridFacing,
  parseVoxelProject,
  renderGrid,
  renderSheet,
  resizeGrid,
  rotateGridCW,
  sheetLayout,
  sheetSprites,
  sheetVariants,
  spriteCells,
  voxelDims,
  voxelIndex,
  type VoxelProject,
  type VoxelSize,
} from "./voxel";

const ONE_CELL: VoxelSize = { cellsX: 1, cellsY: 1, levels: 1 };

function pixel(
  rgba: Uint8ClampedArray,
  widthPx: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const p = (y * widthPx + x) * 4;
  return [rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]];
}

describe("rotateGridCW", () => {
  it("turns a south-facing marker to the west", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    grid[voxelIndex(dims, 3, 7, 0)] = 1;
    const turned = rotateGridCW(grid, ONE_CELL);
    expect(turned[voxelIndex(dims, 0, 3, 0)]).toBe(1);
  });

  it("returns to the original after four turns", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    grid[voxelIndex(dims, 1, 2, 3)] = 5;
    grid[voxelIndex(dims, 6, 0, 7)] = 9;
    let g = grid;
    for (let i = 0; i < 4; i++) g = rotateGridCW(g, ONE_CELL);
    expect(g).toEqual(grid);
  });

  it("swaps footprint dims for non-square models", () => {
    const size: VoxelSize = { cellsX: 2, cellsY: 1, levels: 1 };
    const dims = voxelDims(size);
    const grid = emptyGrid(size);
    grid[voxelIndex(dims, 15, 7, 0)] = 1;
    const { size: turnedSize } = gridFacing(grid, size, "w");
    expect(turnedSize).toEqual({ cellsX: 1, cellsY: 2, levels: 1 });
  });
});

describe("renderGrid", () => {
  it("pads a one-cell model to a 2x2-cell sprite with bottom-right base", () => {
    const grid = emptyGrid(ONE_CELL);
    const sprite = renderGrid(grid, ONE_CELL, ["#000000", "#ff0000"]);
    expect(sprite.cellsW).toBe(2);
    expect(sprite.cellsH).toBe(2);
    expect(sprite.base).toEqual({ x: 1, y: 1 });
  });

  it("projects the ground slice into the bottom-right cell", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    grid[voxelIndex(dims, 0, 0, 0)] = 1;
    const sprite = renderGrid(grid, ONE_CELL, ["#000000", "#ff0000"], { shadeMode: "flat" });
    expect(pixel(sprite.rgba, sprite.widthPx, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(sprite.rgba, sprite.widthPx, 7, 8)[3]).toBe(0);
  });

  it("lets higher voxels win the shared view ray", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    grid[voxelIndex(dims, 5, 5, 0)] = 1;
    grid[voxelIndex(dims, 6, 6, 1)] = 2;
    const palette = ["#000000", "#ff0000", "#00ff00"];
    const sprite = renderGrid(grid, ONE_CELL, palette, { shadeMode: "flat" });
    expect(pixel(sprite.rgba, sprite.widthPx, 8 + 5, 8 + 5)).toEqual([0, 255, 0, 255]);
  });

  it("shades top, south and east faces from one base colour", () => {
    const grid = emptyGrid(ONE_CELL);
    grid.fill(1);
    const sprite = renderGrid(grid, ONE_CELL, ["#000000", "#ffffff"]);
    const topShade = 255;
    const southShade = Math.round(255 * 0.78);
    const eastShade = Math.round(255 * 0.6);
    expect(pixel(sprite.rgba, sprite.widthPx, 4, 4)).toEqual([topShade, topShade, topShade, 255]);
    expect(pixel(sprite.rgba, sprite.widthPx, 8, 15)).toEqual([
      southShade,
      southShade,
      southShade,
      255,
    ]);
    expect(pixel(sprite.rgba, sprite.widthPx, 15, 8)).toEqual([
      eastShade,
      eastShade,
      eastShade,
      255,
    ]);
  });
});

describe("outline pass", () => {
  const RED = ["#000000", "#ff0000"];
  const BLACK: [number, number, number, number] = [0, 0, 0, 255];

  it("leaves the sprite untouched when disabled", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    grid[voxelIndex(dims, 4, 4, 0)] = 1;
    const sprite = renderGrid(grid, ONE_CELL, RED, { shadeMode: "flat" });
    expect(pixel(sprite.rgba, sprite.widthPx, 8 + 3, 8 + 4)[3]).toBe(0);
  });

  it("rings a lone voxel on all four sides", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    grid[voxelIndex(dims, 4, 4, 0)] = 1;
    const sprite = renderGrid(grid, ONE_CELL, RED, {
      shadeMode: "flat",
      outline: "silhouette",
    });
    const [sx, sy] = [8 + 4, 8 + 4];
    expect(pixel(sprite.rgba, sprite.widthPx, sx, sy)).toEqual([255, 0, 0, 255]);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      expect(pixel(sprite.rgba, sprite.widthPx, sx + dx, sy + dy)).toEqual(BLACK);
    }
  });

  it("does not paint outline voxels into the model itself", () => {
    const grid = emptyGrid(ONE_CELL);
    grid.fill(1);
    const outlined = renderGrid(grid, ONE_CELL, RED, {
      shadeMode: "flat",
      outline: "silhouette",
    });
    const plain = renderGrid(grid, ONE_CELL, RED, { shadeMode: "flat" });
    expect(pixel(outlined.rgba, outlined.widthPx, 8, 8)).toEqual(
      pixel(plain.rgba, plain.widthPx, 8, 8),
    );
  });

  it("separates shapes that are far apart in depth", () => {
    const dims = voxelDims(ONE_CELL);
    const grid = emptyGrid(ONE_CELL);
    for (let x = 0; x < 8; x++) {
      for (let z = 0; z < 8; z++) grid[voxelIndex(dims, x, 0, z)] = 1;
    }
    for (let z = 6; z < 8; z++) {
      for (let y = 6; y < 8; y++) {
        for (let x = 6; x < 8; x++) grid[voxelIndex(dims, x, y, z)] = 1;
      }
    }

    const plain = renderGrid(grid, ONE_CELL, RED, { shadeMode: "flat" });
    const outlined = renderGrid(grid, ONE_CELL, RED, {
      shadeMode: "flat",
      outline: "full",
    });
    const edgeOnly = renderGrid(grid, ONE_CELL, RED, {
      shadeMode: "flat",
      outline: "silhouette",
    });

    const blackCount = (rgba: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] === 255 && rgba[i] === 0 && rgba[i + 1] === 0) n++;
      }
      return n;
    };
    expect(blackCount(plain.rgba)).toBe(0);
    expect(blackCount(outlined.rgba)).toBeGreaterThan(blackCount(edgeOnly.rgba));
  });
});

describe("resizeGrid", () => {
  it("keeps voxels anchored to the footprint bottom-right and the ground", () => {
    const from = ONE_CELL;
    const to: VoxelSize = { cellsX: 2, cellsY: 2, levels: 2 };
    const fromDims = voxelDims(from);
    const toDims = voxelDims(to);
    const grid = emptyGrid(from);
    grid[voxelIndex(fromDims, 7, 7, 0)] = 3;
    const grown = resizeGrid(grid, from, to);
    expect(grown[voxelIndex(toDims, 15, 15, 0)]).toBe(3);
  });
});

function testProject(overrides: Partial<VoxelProject> = {}): VoxelProject {
  return {
    name: "test",
    size: ONE_CELL,
    palette: ["#000000", "#ff0000"],
    frames: [{ voxels: Array.from(emptyGrid(ONE_CELL)), durationMs: 200 }],
    directional: true,
    ...overrides,
  };
}

describe("sheet export", () => {
  it("lays out directions as rows and frames as columns", () => {
    const project = testProject({
      frames: [
        { voxels: Array.from(emptyGrid(ONE_CELL)), durationMs: 200 },
        { voxels: Array.from(emptyGrid(ONE_CELL)), durationMs: 200 },
      ],
    });
    const layout = sheetLayout(project);
    expect(layout.widthPx).toBe(2 * 16);
    expect(layout.heightPx).toBe(4 * 16);
    const { rgba } = renderSheet(project);
    expect(rgba.length).toBe(layout.widthPx * layout.heightPx * 4);
  });

  it("emits variants whose rects tile the sheet", () => {
    const project = testProject();
    const variants = sheetVariants(project, "my-sheet");
    expect(Object.keys(variants)).toEqual(["n", "e", "s", "w"]);
    expect(variants.e?.[0].sprite.rect).toEqual({ x: 0, y: 2, w: 2, h: 2 });
    expect(variants.e?.[0].sprite.base).toEqual({ x: 1, y: 1 });
  });

  it("emits typed sprites for TileDef export", () => {
    const project = testProject();
    const sheet = sheetSprites(project);
    expect(sheet.type).toBe("directional");
    expect(sheet.sprites?.e?.frames[0].sprite.rect).toEqual({
      x: 0,
      y: 2,
      w: 2,
      h: 2,
    });
  });

  it("uses a single default row for non-directional models", () => {
    const project = testProject({ directional: false });
    const variants = sheetVariants(project, "my-sheet");
    expect(Object.keys(variants)).toEqual(["default"]);
    const sheet = sheetSprites(project);
    expect(sheet.type).toBe("simple");
    expect(sheet.sprite?.frames).toHaveLength(1);
  });
});

describe("parseVoxelProject", () => {
  it("rejects frames that do not match the model size", () => {
    const bad = { ...testProject(), frames: [{ voxels: [0], durationMs: 100 }] };
    expect(() => parseVoxelProject(bad)).toThrow();
  });

  it("rejects out-of-palette voxel indices", () => {
    const project = testProject();
    project.frames[0].voxels[0] = 99;
    expect(() => parseVoxelProject(project)).toThrow();
  });

  it("accepts a valid round-tripped project", () => {
    const project = testProject();
    expect(parseVoxelProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
  });
});

describe("spriteCells", () => {
  it("accounts for the up-left height shift", () => {
    expect(spriteCells({ cellsX: 2, cellsY: 2, levels: 1 })).toEqual({
      cellsW: 3,
      cellsH: 3,
    });
  });
});
