import { CELL_SIZE } from "./types";

/** 1 height unit = 2px up-left on screen. */
export const PX_PER_HEIGHT = 2;

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

/** Painter's algorithm sort key within a level. */
export function drawOrder(x: number, y: number, stackIndex: number): number {
  return y * 1_000_000 + x * 1_000 + stackIndex;
}
