import * as v from "valibot";
import { CELL_SIZE, DIRECTIONS, defaultBase } from "./types";
import type { CellRect, Direction, Frame, TileSprite } from "./types";

/**
 * Voxel space matches the game projection 1:1: a voxel is 1px wide/deep,
 * and 1 voxel of height shifts its pixel 1px up-left on screen — so a full
 * level (8px shift, see geometry.ts) is 8 voxels tall.
 */
export const VOXELS_PER_CELL = CELL_SIZE;
export const VOXELS_PER_LEVEL = CELL_SIZE;

/** Palette index 0 is always "empty" — no voxel. */
export const EMPTY_VOXEL = 0;

export const MAX_PALETTE_SIZE = 256;

export const DEFAULT_FRAME_DURATION_MS = 200;

/** Model size in map units: footprint in cells, height in levels. */
export type VoxelSize = {
  cellsX: number;
  cellsY: number;
  levels: number;
};

/** Voxel-grid dimensions (1 voxel = 1px). */
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

/** x runs east, y runs south, z runs up. */
export function voxelIndex(dims: VoxelDims, x: number, y: number, z: number) {
  return z * dims.vx * dims.vy + y * dims.vx + x;
}

/** Inverse of {@link voxelIndex}. */
export function voxelCoords(
  dims: VoxelDims,
  index: number,
): { x: number; y: number; z: number } {
  const sliceSize = dims.vx * dims.vy;
  const z = Math.floor(index / sliceSize);
  const rest = index % sliceSize;
  return { x: rest % dims.vx, y: Math.floor(rest / dims.vx), z };
}

/** Flat array of palette indices, length vx*vy*vz. */
export type VoxelGrid = Uint8Array;

export function emptyGrid(size: VoxelSize): VoxelGrid {
  return new Uint8Array(voxelCount(size));
}

/**
 * Copy a grid into a new size, keeping voxels anchored to the footprint's
 * bottom-right corner and the ground (z=0) — matching how sprites are
 * anchored to their base cell, so growing a model pads up/left/top.
 */
export function resizeGrid(
  grid: VoxelGrid,
  from: VoxelSize,
  to: VoxelSize,
): VoxelGrid {
  const a = voxelDims(from);
  const b = voxelDims(to);
  const out = new Uint8Array(b.vx * b.vy * b.vz);
  const shiftX = b.vx - a.vx;
  const shiftY = b.vy - a.vy;
  for (let i = 0; i < grid.length; i++) {
    const val = grid[i]!;
    if (val === EMPTY_VOXEL) continue;
    const { x, y, z } = voxelCoords(a, i);
    const tx = x + shiftX;
    const ty = y + shiftY;
    if (tx < 0 || ty < 0 || tx >= b.vx || ty >= b.vy || z >= b.vz) continue;
    out[voxelIndex(b, tx, ty, z)] = val;
  }
  return out;
}

/**
 * Rotate a grid a quarter turn clockwise (seen from above, y pointing
 * south). A south-facing model becomes west-facing after one turn.
 */
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
    const val = grid[i]!;
    if (val === EMPTY_VOXEL) continue;
    const { x, y, z } = voxelCoords(dims, i);
    out[voxelIndex(rDims, dims.vy - 1 - y, x, z)] = val;
  }
  return out;
}

/** Quarter turns of {@link rotateGridCW} that face a south-authored model each way. */
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

/**
 * The camera sits up-right-front of the model (Tibia-style oblique), so the
 * visible faces are top (+z), south (+y) and east (+x). Light comes from
 * above: the top face keeps the base colour and the walls darken.
 */
const FACE_SHADE_TOP = 1;
const FACE_SHADE_SOUTH = 0.78;
const FACE_SHADE_EAST = 0.6;
const FACE_SHADE_CORNER = 0.5;

export type ShadeMode = "faces" | "flat";

/**
 * Outlines belong to the 2D read of the sprite, not to the model: they mark
 * where a shape ends, so they are drawn as a pass over the projection rather
 * than painted as black voxels.
 * - `silhouette` rings the sprite against the background.
 * - `full` also separates parts that overlap on screen but sit far apart in
 *   space (a raised sword against the torso behind it).
 */
export type OutlineMode = "none" | "silhouette" | "full";

const OUTLINE_COLOR = "#000000";

/**
 * Camera-distance gap that reads as "different shape". Smooth surfaces step
 * by 1 per pixel, so anything from 3 up is a genuine separation.
 */
const DEPTH_OUTLINE_THRESHOLD = 3;

const NO_DEPTH = -1;

type Rgb = [number, number, number];

/** Magenta, the project's "missing sprite" colour — signals a bad palette entry. */
const MISSING_COLOR: Rgb = [255, 0, 255];

export function parseHexColor(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return MISSING_COLOR;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function shade([r, g, b]: Rgb, factor: number): Rgb {
  return [
    Math.round(r * factor),
    Math.round(g * factor),
    Math.round(b * factor),
  ];
}

export type RenderedSprite = {
  /** Padded to whole cells so it drops straight into a tileset. */
  widthPx: number;
  heightPx: number;
  cellsW: number;
  cellsH: number;
  /** Base cell (bottom-right of the padded rect, where the footprint sits). */
  base: { x: number; y: number };
  /** RGBA, widthPx × heightPx. Empty pixels are fully transparent. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
};

/** Sprite cell size for a model: projection needs vx+vz−1 × vy+vz−1 px. */
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

/**
 * Render a grid in the game projection: voxel (x,y,z) → pixel (x−z, y−z),
 * painter-ordered so higher voxels along a view ray win. The model is
 * anchored bottom-right so the footprint lands in the sprite's base cell.
 */
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
  // Camera distance of the voxel that won each pixel; drives depth outlines.
  const depth = new Int16Array(widthPx * heightPx).fill(NO_DEPTH);

  // Flat-index order is z, then y, then x ascending — exactly painter order,
  // since along a view ray only higher-z voxels overdraw (see voxel.test.ts).
  for (let i = 0; i < grid.length; i++) {
    const val = grid[i]!;
    if (val === EMPTY_VOXEL) continue;
    const { x, y, z } = voxelCoords(dims, i);
    const sx = x - z + offsetX;
    const sy = y - z + offsetY;
    if (sx < 0 || sy < 0 || sx >= widthPx || sy >= heightPx) continue;
    const factor =
      shadeMode === "flat"
        ? FACE_SHADE_TOP
        : visibleFaceShade(grid, dims, x, y, z);
    const [r, g, b] = shade(colors[val] ?? MISSING_COLOR, factor);
    const p = (sy * widthPx + sx) * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
    rgba[p + 3] = 255;
    // The view ray runs along (+1,+1,+1), so this sum grows toward the camera.
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

/**
 * Paint outline pixels over the projection. Runs off a snapshot of the depth
 * buffer so freshly drawn outline never seeds more outline.
 */
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
      const here = depth[sy * widthPx + sx]!;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = sx + dx;
        const ny = sy + dy;
        if (nx < 0 || ny < 0 || nx >= widthPx || ny >= heightPx) continue;
        const there = depth[ny * widthPx + nx]!;
        // Empty pixel touching the model: ring the silhouette.
        if (here === NO_DEPTH && there !== NO_DEPTH) {
          targets.push(sy * widthPx + sx);
          break;
        }
        // Filled pixel sitting well behind its neighbour: separate the shapes
        // by darkening the farther one, so the nearer shape keeps its size.
        if (
          mode === "full" &&
          here !== NO_DEPTH &&
          there - here >= DEPTH_OUTLINE_THRESHOLD
        ) {
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

function isFilled(
  grid: VoxelGrid,
  dims: VoxelDims,
  x: number,
  y: number,
  z: number,
): boolean {
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

// ---------------------------------------------------------------------------
// Project files

export type VoxelFrame = {
  voxels: number[];
  durationMs: number;
};

export type VoxelProject = {
  name: string;
  size: VoxelSize;
  /** Index 0 is transparent and never painted; kept for stable indices. */
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
    (p) =>
      p.frames.every((f) => f.voxels.every((i) => i < p.palette.length)),
    "voxel references a palette index that does not exist",
  ),
);

export function parseVoxelProject(raw: unknown): VoxelProject {
  return v.parse(voxelProjectSchema, raw);
}

// ---------------------------------------------------------------------------
// Spritesheet export

export type SheetLayout = {
  /** Frame slot size in cells — every direction/frame shares one slot size. */
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
  const keys: (Direction | "default")[] = project.directional
    ? DIRECTIONS
    : ["default"];
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

/** Render every direction × frame into one RGBA sheet (rows = directions). */
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
      const faced = gridFacing(
        Uint8Array.from(frame.voxels),
        project.size,
        direction,
      );
      const sprite = renderGrid(
        faced.grid,
        faced.size,
        project.palette,
        options,
      );
      // Bottom-right align inside the slot so the base cell stays put even
      // when a non-square footprint renders smaller for some directions.
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
      dest[d] = sprite.rgba[s]!;
      dest[d + 1] = sprite.rgba[s + 1]!;
      dest[d + 2] = sprite.rgba[s + 2]!;
      dest[d + 3] = sprite.rgba[s + 3]!;
    }
  }
}

/** Tile sprites for a TileDef pointing at the exported sheet. */
export function sheetSprites(
  project: VoxelProject,
  tilesetId: string,
): { type: "simple" | "directional"; sprite?: TileSprite; sprites?: Partial<Record<Direction, TileSprite>> } {
  const layout = sheetLayout(project);
  const rows = layout.rows;
  const toSprite = (rowIdx: number): TileSprite => ({
    frames: project.frames.map((frame, colIdx) => ({
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

/** @deprecated Prefer {@link sheetSprites}. */
export function sheetVariants(
  project: VoxelProject,
  tilesetId: string,
): Partial<Record<Direction | "default", Frame[]>> {
  const layout = sheetLayout(project);
  const out: Partial<Record<Direction | "default", Frame[]>> = {};
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
