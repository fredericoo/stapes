import { CELL_SIZE, HEIGHT_PER_LEVEL } from "./types";

/** 1 height unit = 2px up-left on screen. */
export const PX_PER_HEIGHT = 2;

/**
 * Absolute foot elevation for a tile: level floor + in-stack elevation.
 * Matches gameplay (`absoluteStandingElevation`) so overflow stacks sort
 * against superior-level tiles by height, not by level membership.
 */
export function absoluteElevation(z: number, elevation: number): number {
  return z * HEIGHT_PER_LEVEL + elevation;
}

/** Full level (4 height units) = 8px = one cell. */
export function levelScreenOffset(z: number): { x: number; y: number } {
  return { x: -CELL_SIZE * z, y: -CELL_SIZE * z };
}

/** Elevation within a stack: e height units → 2e px up-left. */
export function elevationScreenOffset(e: number): { x: number; y: number } {
  return { x: -PX_PER_HEIGHT * e, y: -PX_PER_HEIGHT * e };
}

/**
 * World-pixel position of the top-left of the base cell for a placed tile.
 * The base cell sits on (x, y) at level z with elevation e.
 */
export function baseCellWorldOrigin(
  x: number,
  y: number,
  z: number,
  elevation: number,
): { x: number; y: number } {
  const level = levelScreenOffset(z);
  const elev = elevationScreenOffset(elevation);
  return {
    x: x * CELL_SIZE + level.x + elev.x,
    y: y * CELL_SIZE + level.y + elev.y,
  };
}

/**
 * World-pixel top-left of a multi-cell sprite whose base cell is at the given origin.
 * Sprite rect is in cells; base is relative within the rect.
 */
export function spriteWorldOrigin(
  baseOrigin: { x: number; y: number },
  base: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: baseOrigin.x - base.x * CELL_SIZE,
    y: baseOrigin.y - base.y * CELL_SIZE,
  };
}

/**
 * Invert projection for the current level:
 * worldPx = screen/zoom + cameraOffset
 * coord = floor((worldPx + 8*currentZ) / 8)
 */
export function screenToCoord(
  screenX: number,
  screenY: number,
  zoom: number,
  cameraOffsetX: number,
  cameraOffsetY: number,
  currentZ: number,
): { x: number; y: number } {
  const worldX = screenX / zoom + cameraOffsetX;
  const worldY = screenY / zoom + cameraOffsetY;
  return {
    x: Math.floor((worldX + CELL_SIZE * currentZ) / CELL_SIZE),
    y: Math.floor((worldY + CELL_SIZE * currentZ) / CELL_SIZE),
  };
}

/**
 * Painter's algorithm sort key across levels.
 * South (y) and east (x) decide screen occlusion first; absolute elevation
 * only orders tiles that share a cell (incl. overflow vs the level above).
 */
export function drawOrder(
  x: number,
  y: number,
  absElev: number,
  stackIndex: number,
): number {
  return y * 1_000_000_000 + x * 1_000_000 + absElev * 1_000 + stackIndex;
}

/**
 * Ortho mesh depth from the same key as {@link drawOrder}.
 * Kept in ~[0, 20] for the editor/world camera frustum + 24-bit depth buffer.
 *
 * Grid position outranks height so tall western tiles don't cover eastern
 * neighbours; absElev still replaces old per-level depth bands.
 */
export function tileDepth(
  x: number,
  y: number,
  absElev: number,
  stackIndex: number,
): number {
  // Spaced for ~128 cells and ~128 elev units without z-fighting the depth buffer.
  return (
    (y + 64) * 0.1 +
    (x + 64) * 0.0007 +
    (absElev + 64) * 0.000005 +
    stackIndex * 0.0000001
  );
}
