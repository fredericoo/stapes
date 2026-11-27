import type { PNG } from "pngjs";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import type { Direction } from "../app/lib/types";
import { CELL_SIZE } from "../app/lib/types";

export type Rgba = readonly [number, number, number, number];

export const SOUTH_GABLE: Rgba = [255, 255, 255, 255];
export const EAST_GABLE: Rgba = [199, 220, 208, 255];

export type Surface = (x: number, y: number) => number;

/** An eave rises `rise` units across its cell, from the eave up to the side it faces away from. */
export function eaveSurface(facing: Direction, rise: number): Surface {
  const run = CELL_SIZE / rise;
  switch (facing) {
    case "e":
      return (x) => x / run;
    case "w":
      return (x) => (CELL_SIZE - x) / run;
    case "s":
      return (_, y) => y / run;
    case "n":
      return (_, y) => (CELL_SIZE - y) / run;
  }
}

export function ridgeSurface(axis: "ns" | "ew", rise: number): Surface {
  const half = CELL_SIZE / 2;
  return axis === "ns"
    ? (x) => rise * (1 - Math.abs(x - half) / half)
    : (_, y) => rise * (1 - Math.abs(y - half) / half);
}

type Hit = { face: "top" | "south" | "east"; x: number; y: number };

export const clampToCell = (v: number) => Math.min(Math.max(v, 0), CELL_SIZE - 1e-3);

export type Lip = { x: number; y: number };
export const ALONG_X: Lip = { x: 1, y: 0 };
export const ALONG_Y: Lip = { x: 0, y: 1 };

/**
 * Marches the view ray from the top of the tile down until it enters the solid
 * under `surface`. A point `h` units up draws `PX_PER_HEIGHT * h` px up and to
 * the left, so the ray through a screen pixel is `(X + 2h, Y + 2h, h)`.
 *
 * The slope runs `lip` px past the cell's north or west edge, over the gable of
 * the cell before it along the ridge. Rasterised separately, that gable and this
 * slope's edge land on different pixels, and a line of gable shows between them.
 */
function cast(surface: Surface, top: number, X: number, Y: number, lip: Lip): Hit | null {
  let prev: { x: number; y: number } | null = null;
  for (let h = top + 0.01; h >= 0; h -= 0.005) {
    const x = X + PX_PER_HEIGHT * h;
    const y = Y + PX_PER_HEIGHT * h;
    const inside =
      x >= -lip.x &&
      x < CELL_SIZE &&
      y >= -lip.y &&
      y < CELL_SIZE &&
      h <= surface(clampToCell(x), clampToCell(y));
    if (inside) {
      if (prev && prev.y >= CELL_SIZE) return { face: "south", x, y };
      if (prev && prev.x >= CELL_SIZE) return { face: "east", x, y };
      return { face: "top", x, y };
    }
    prev = { x, y };
  }
  return null;
}

/** Where on a slope a screen pixel landed: `x` and `y` in the cell, `X` and `Y` on screen relative to the cell. */
export type SlopeHit = { x: number; y: number; X: number; Y: number };

export const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;

export function drawSprite(
  sheet: PNG,
  left: number,
  top: number,
  surface: Surface,
  rise: number,
  lip: Lip,
  slope: (hit: SlopeHit) => Rgba,
) {
  const mod = (v: number) => ((v % CELL_SIZE) + CELL_SIZE) % CELL_SIZE;
  for (let sy = 0; sy < SPRITE_PX; sy++) {
    for (let sx = 0; sx < SPRITE_PX; sx++) {
      const X = sx - CELL_SIZE + 0.5;
      const Y = sy - CELL_SIZE + 0.5;
      const hit = cast(surface, rise, X, Y, lip);
      let rgba: Rgba = [0, 0, 0, 0];
      if (hit?.face === "south") rgba = SOUTH_GABLE;
      else if (hit?.face === "east") rgba = EAST_GABLE;
      else if (hit) rgba = slope({ x: mod(hit.x), y: mod(hit.y), X, Y });
      const i = ((top + sy) * sheet.width + left + sx) * 4;
      for (let c = 0; c < 4; c++) sheet.data[i + c] = rgba[c]!;
    }
  }
}

/**
 * Which way the slope under `x`, `y` falls: along x for a slope facing east or
 * west, along y for one facing south or north, and whether it faces the light.
 */
export function slopeFacing(
  surface: Surface,
  x: number,
  y: number,
): { alongX: boolean; lit: boolean } {
  const e = 0.01;
  const slopeX = surface(clampToCell(x + e), y) - surface(clampToCell(x - e), y);
  const slopeY = surface(x, clampToCell(y + e)) - surface(x, clampToCell(y - e));
  if (Math.abs(slopeX) >= Math.abs(slopeY)) return { alongX: true, lit: slopeX < 0 };
  return { alongX: false, lit: slopeY < 0 };
}

export const EAVE_FACINGS: Direction[] = ["n", "e", "s", "w"];

export function frames(x: number, y: number) {
  return {
    frames: [
      {
        sprite: {
          rect: { x, y, w: SPRITE_CELLS, h: SPRITE_CELLS },
          base: { x: 1, y: 1 },
        },
        durationMs: 200,
      },
    ],
  };
}
