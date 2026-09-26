import * as v from "valibot";
import { CELL_SIZE, DIRECTIONS, defaultBase } from "./types";
import type { CellRect, Direction, Frame, TileSprite } from "./types";

export const VOXELS_PER_CELL = CELL_SIZE;
export const VOXELS_PER_LEVEL = CELL_SIZE;

export const EMPTY_VOXEL = 0;

export const MAX_PALETTE_SIZE = 256;

export const DEFAULT_FRAME_DURATION_MS = 200;

export type VoxelSize = {
  cellsX: number;
  cellsY: number;
  levels: number;
};

export type VoxelDims = { vx: number; vy: number; vz: number };

export function voxelDims(size: VoxelSize): VoxelDims {
  return {
    vx: size.cellsX * VOXELS_PER_CELL,
    vy: size.cellsY * VOXELS_PER_CELL,
    vz: size.levels * VOXELS_PER_LEVEL,
  };
}

export function voxelCount(size: VoxelSize): number {
  const { vx, vy, vz } = voxelDims(size);
  return vx * vy * vz;
}

export function voxelIndex(dims: VoxelDims, x: number, y: number, z: number) {
  return z * dims.vx * dims.vy + y * dims.vx + x;
}

export function voxelCoords(dims: VoxelDims, index: number): { x: number; y: number; z: number } {
  const sliceSize = dims.vx * dims.vy;
  const z = Math.floor(index / sliceSize);
  const rest = index % sliceSize;
  return { x: rest % dims.vx, y: Math.floor(rest / dims.vx), z };
}

export type VoxelGrid = Uint8Array;

export function emptyGrid(size: VoxelSize): VoxelGrid {
  return new Uint8Array(voxelCount(size));
}

export function resizeGrid(grid: VoxelGrid, from: VoxelSize, to: VoxelSize): VoxelGrid {
  const a = voxelDims(from);
  const b = voxelDims(to);
  const out = new Uint8Array(b.vx * b.vy * b.vz);
  const shiftX = b.vx - a.vx;
  const shiftY = b.vy - a.vy;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === EMPTY_VOXEL) continue;
    const { x, y, z } = voxelCoords(a, i);
    const tx = x + shiftX;
    const ty = y + shiftY;
    if (tx < 0 || ty < 0 || tx >= b.vx || ty >= b.vy || z >= b.vz) continue;
    out[voxelIndex(b, tx, ty, z)] = grid[i];
  }
  return out;
}

export function rotateGridCW(grid: VoxelGrid, size: VoxelSize): VoxelGrid {
  const dims = voxelDims(size);
  const rotated: VoxelSize = {
    cellsX: size.cellsY,
    cellsY: size.cellsX,
    levels: size.levels,
  };
  const rDims = voxelDims(rotated);
  const out = new Uint8Array(rDims.vx * rDims.vy * rDims.vz);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === EMPTY_VOXEL) continue;
    const { x, y, z } = voxelCoords(dims, i);
    out[voxelIndex(rDims, dims.vy - 1 - y, x, z)] = grid[i];
  }
  return out;
}

export const TURNS_BY_DIRECTION: Record<Direction, number> = {
  s: 0,
  w: 1,
  n: 2,
  e: 3,
};

export function gridFacing(
  grid: VoxelGrid,
  size: VoxelSize,
  direction: Direction,
): { grid: VoxelGrid; size: VoxelSize } {
  let g = grid;
  let s = size;
  for (let t = 0; t < TURNS_BY_DIRECTION[direction]; t++) {
    g = rotateGridCW(g, s);
    s = { cellsX: s.cellsY, cellsY: s.cellsX, levels: s.levels };
  }
  return { grid: g, size: s };
}

const FACE_SHADE_TOP = 1;
const FACE_SHADE_SOUTH = 0.78;
const FACE_SHADE_EAST = 0.6;
const FACE_SHADE_CORNER = 0.5;

export type ShadeMode = "faces" | "flat";

export type OutlineMode = "none" | "silhouette" | "full";

const OUTLINE_COLOR = "#000000";

const DEPTH_OUTLINE_THRESHOLD = 3;

const NO_DEPTH = -1;

type Rgb = [number, number, number];

const MISSING_COLOR: Rgb = [255, 0, 255];

export function parseHexColor(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return MISSING_COLOR;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function shade([r, g, b]: Rgb, factor: number): Rgb {
  return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
}

export type RenderedSprite = {
  widthPx: number;
  heightPx: number;
  cellsW: number;
  cellsH: number;
  base: { x: number; y: number };
  rgba: Uint8ClampedArray<ArrayBuffer>;
};

export function spriteCells(size: VoxelSize): { cellsW: number; cellsH: number } {
  const { vx, vy, vz } = voxelDims(size);
  return {
    cellsW: Math.ceil((vx + vz - 1) / CELL_SIZE),
    cellsH: Math.ceil((vy + vz - 1) / CELL_SIZE),
  };
}

export type RenderOptions = {
  shadeMode?: ShadeMode;
  outline?: OutlineMode;
};

export function renderGrid(
  grid: VoxelGrid,
  size: VoxelSize,
  palette: string[],
  { shadeMode = "faces", outline = "none" }: RenderOptions = {},
): RenderedSprite {
  const dims = voxelDims(size);
  const { cellsW, cellsH } = spriteCells(size);
  const widthPx = cellsW * CELL_SIZE;
  const heightPx = cellsH * CELL_SIZE;
  const offsetX = widthPx - dims.vx;
  const offsetY = heightPx - dims.vy;
  const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
  const colors = palette.map(parseHexColor);
  const depth = new Int16Array(widthPx * heightPx).fill(NO_DEPTH);

  for (let i = 0; i < grid.length; i++) {
    const val = grid[i];
    if (val === EMPTY_VOXEL) continue;
    const { x, y, z } = voxelCoords(dims, i);
    const sx = x - z + offsetX;
    const sy = y - z + offsetY;
    if (sx < 0 || sy < 0 || sx >= widthPx || sy >= heightPx) continue;
    const factor = shadeMode === "flat" ? FACE_SHADE_TOP : visibleFaceShade(grid, dims, x, y, z);
    const [r, g, b] = shade(colors[val] ?? MISSING_COLOR, factor);
    const p = (sy * widthPx + sx) * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
    rgba[p + 3] = 255;
    depth[sy * widthPx + sx] = x + y + z;
  }

  if (outline !== "none") {
    applyOutline(rgba, depth, widthPx, heightPx, outline);
  }

  const rect: CellRect = { x: 0, y: 0, w: cellsW, h: cellsH };
  return { widthPx, heightPx, cellsW, cellsH, base: defaultBase(rect), rgba };
}

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function applyOutline(
  rgba: Uint8ClampedArray,
  depth: Int16Array,
  widthPx: number,
  heightPx: number,
  mode: OutlineMode,
) {
  const [r, g, b] = parseHexColor(OUTLINE_COLOR);
  const targets: number[] = [];

  for (let sy = 0; sy < heightPx; sy++) {
    for (let sx = 0; sx < widthPx; sx++) {
      const here = depth[sy * widthPx + sx];
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = sx + dx;
        const ny = sy + dy;
        if (nx < 0 || ny < 0 || nx >= widthPx || ny >= heightPx) continue;
        const there = depth[ny * widthPx + nx];
        if (here === NO_DEPTH && there !== NO_DEPTH) {
          targets.push(sy * widthPx + sx);
          break;
        }
        if (mode === "full" && here !== NO_DEPTH && there - here >= DEPTH_OUTLINE_THRESHOLD) {
          targets.push(sy * widthPx + sx);
          break;
        }
      }
    }
  }

  for (const pixel of targets) {
    const p = pixel * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
    rgba[p + 3] = 255;
  }
}

function isFilled(grid: VoxelGrid, dims: VoxelDims, x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || z < 0 || x >= dims.vx || y >= dims.vy || z >= dims.vz) {
    return false;
  }
  return grid[voxelIndex(dims, x, y, z)] !== EMPTY_VOXEL;
}

function visibleFaceShade(
  grid: VoxelGrid,
  dims: VoxelDims,
  x: number,
  y: number,
  z: number,
): number {
  if (!isFilled(grid, dims, x, y, z + 1)) return FACE_SHADE_TOP;
  if (!isFilled(grid, dims, x, y + 1, z)) return FACE_SHADE_SOUTH;
  if (!isFilled(grid, dims, x + 1, y, z)) return FACE_SHADE_EAST;
  return FACE_SHADE_CORNER;
}

export type VoxelFrame = {
  voxels: number[];
  durationMs: number;
};

export type VoxelProject = {
  name: string;
  size: VoxelSize;
  palette: string[];
  frames: VoxelFrame[];
  directional: boolean;
};

const sizeSchema = v.object({
  cellsX: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
  cellsY: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
  levels: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4)),
});

export const voxelProjectSchema = v.pipe(
  v.object({
    name: v.pipe(v.string(), v.maxLength(64)),
    size: sizeSchema,
    palette: v.pipe(
      v.array(v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i))),
      v.minLength(1),
      v.maxLength(MAX_PALETTE_SIZE),
    ),
    frames: v.pipe(
      v.array(
        v.object({
          voxels: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
          durationMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
        }),
      ),
      v.minLength(1),
    ),
    directional: v.boolean(),
  }),
  v.check(
    (p) => p.frames.every((f) => f.voxels.length === voxelCount(p.size)),
    "frame voxel data does not match model size",
  ),
  v.check(
    (p) => p.frames.every((f) => f.voxels.every((i) => i < p.palette.length)),
    "voxel references a palette index that does not exist",
  ),
);

export function parseVoxelProject(raw: unknown): VoxelProject {
  return v.parse(voxelProjectSchema, raw);
}

export type SheetLayout = {
  cellsW: number;
  cellsH: number;
  columns: number;
  rows: { key: Direction | "default"; frames: number }[];
  widthPx: number;
  heightPx: number;
};

export function sheetLayout(project: VoxelProject): SheetLayout {
  const south = spriteCells(project.size);
  const rotated = spriteCells({
    cellsX: project.size.cellsY,
    cellsY: project.size.cellsX,
    levels: project.size.levels,
  });
  const cellsW = Math.max(south.cellsW, rotated.cellsW);
  const cellsH = Math.max(south.cellsH, rotated.cellsH);
  const keys: (Direction | "default")[] = project.directional ? DIRECTIONS : ["default"];
  const columns = project.frames.length;
  return {
    cellsW,
    cellsH,
    columns,
    rows: keys.map((key) => ({ key, frames: columns })),
    widthPx: columns * cellsW * CELL_SIZE,
    heightPx: keys.length * cellsH * CELL_SIZE,
  };
}

export function renderSheet(
  project: VoxelProject,
  options: RenderOptions = {},
): { layout: SheetLayout; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const layout = sheetLayout(project);
  const rgba = new Uint8ClampedArray(layout.widthPx * layout.heightPx * 4);
  const slotW = layout.cellsW * CELL_SIZE;
  const slotH = layout.cellsH * CELL_SIZE;

  layout.rows.forEach((row, rowIdx) => {
    project.frames.forEach((frame, colIdx) => {
      const direction: Direction = row.key === "default" ? "s" : row.key;
      const faced = gridFacing(Uint8Array.from(frame.voxels), project.size, direction);
      const sprite = renderGrid(faced.grid, faced.size, project.palette, options);
      const dx = colIdx * slotW + (slotW - sprite.widthPx);
      const dy = rowIdx * slotH + (slotH - sprite.heightPx);
      blit(rgba, layout.widthPx, sprite, dx, dy);
    });
  });

  return { layout, rgba };
}

function blit(
  dest: Uint8ClampedArray,
  destWidthPx: number,
  sprite: RenderedSprite,
  dx: number,
  dy: number,
) {
  for (let y = 0; y < sprite.heightPx; y++) {
    for (let x = 0; x < sprite.widthPx; x++) {
      const s = (y * sprite.widthPx + x) * 4;
      if (sprite.rgba[s + 3] === 0) continue;
      const d = ((dy + y) * destWidthPx + dx + x) * 4;
      dest[d] = sprite.rgba[s];
      dest[d + 1] = sprite.rgba[s + 1];
      dest[d + 2] = sprite.rgba[s + 2];
      dest[d + 3] = sprite.rgba[s + 3];
    }
  }
}

export function sheetSprites(project: VoxelProject): {
  type: "simple" | "directional";
  sprite?: TileSprite;
  sprites?: Partial<Record<Direction, TileSprite>>;
} {
  const layout = sheetLayout(project);
  const rows = layout.rows;
  const toSprite = (rowIdx: number): TileSprite => ({
    frames: project.frames.map((frame, colIdx) => ({
      sprite: {
        rect: {
          x: colIdx * layout.cellsW,
          y: rowIdx * layout.cellsH,
          w: layout.cellsW,
          h: layout.cellsH,
        },
        base: { x: layout.cellsW - 1, y: layout.cellsH - 1 },
      },
      durationMs: frame.durationMs,
    })),
  });

  if (!project.directional) {
    return { type: "simple", sprite: toSprite(0) };
  }

  const sprites: Partial<Record<Direction, TileSprite>> = {};
  rows.forEach((row, rowIdx) => {
    if (row.key === "default") return;
    sprites[row.key] = toSprite(rowIdx);
  });
  return { type: "directional", sprites };
}

type LegacyFrame = Omit<Frame, "sprite"> & {
  sprite: Frame["sprite"] & { tilesetId: string };
};

export function sheetVariants(
  project: VoxelProject,
  tilesetId: string,
): Partial<Record<Direction | "default", LegacyFrame[]>> {
  const layout = sheetLayout(project);
  const out: Partial<Record<Direction | "default", LegacyFrame[]>> = {};
  layout.rows.forEach((row, rowIdx) => {
    out[row.key] = project.frames.map((frame, colIdx) => ({
      sprite: {
        tilesetId,
        rect: {
          x: colIdx * layout.cellsW,
          y: rowIdx * layout.cellsH,
          w: layout.cellsW,
          h: layout.cellsH,
        },
        base: { x: layout.cellsW - 1, y: layout.cellsH - 1 },
      },
      durationMs: frame.durationMs,
    }));
  });
  return out;
}
