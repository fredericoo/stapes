import { CELL_SIZE, HEIGHT_PER_LEVEL, MIN_LEVEL } from "./types";

export const PX_PER_HEIGHT = CELL_SIZE / HEIGHT_PER_LEVEL;

export const RAY_DEPTH_ELEV = HEIGHT_PER_LEVEL + 0.5;

export const WADE_SINK_PX = PX_PER_HEIGHT;

export const WADE_EDGE_PX = 2;

export const CELL_CENTRE = 0.5;

export function absoluteElevation(z: number, elevation: number): number {
  return z * HEIGHT_PER_LEVEL + elevation;
}

export function levelScreenOffset(z: number): { x: number; y: number } {
  return { x: -CELL_SIZE * z, y: -CELL_SIZE * z };
}

export function elevationScreenOffset(e: number): { x: number; y: number } {
  return { x: -PX_PER_HEIGHT * e, y: -PX_PER_HEIGHT * e };
}

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

export function spriteWorldOrigin(
  baseOrigin: { x: number; y: number },
  base: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: baseOrigin.x - base.x * CELL_SIZE,
    y: baseOrigin.y - base.y * CELL_SIZE,
  };
}

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

export function drawOrder(x: number, y: number, absElev: number, stackIndex: number): number {
  return y * 1_000_000_000 + x * 1_000_000 + absElev * 1_000 + stackIndex;
}

export type DepthBox = {
  eastPx: number;
  southPx: number;
  foot: number;
  top: number;
};

export function depthBox(x: number, y: number, foot: number, top: number): DepthBox {
  return {
    eastPx: (x + 1) * CELL_SIZE,
    southPx: (y + 1) * CELL_SIZE,
    foot,
    top,
  };
}

export function rayDepth(screenX: number, screenY: number, elev: number): number {
  return (screenX + screenY) / CELL_SIZE + RAY_DEPTH_ELEV * elev;
}

function boxExitElevation(box: DepthBox, screenX: number, screenY: number): number {
  return Math.min(
    (box.eastPx - screenX) / PX_PER_HEIGHT,
    (box.southPx - screenY) / PX_PER_HEIGHT,
    box.top,
  );
}

function boxFarFaceElevation(box: DepthBox, screenX: number, screenY: number): number {
  return (
    Math.max((box.eastPx - screenX) / PX_PER_HEIGHT, (box.southPx - screenY) / PX_PER_HEIGHT) -
    HEIGHT_PER_LEVEL
  );
}

export function boxSurface(
  box: DepthBox,
  screenX: number,
  screenY: number,
): { elevation: number; overhang: boolean } {
  const exit = boxExitElevation(box, screenX, screenY);
  const farFace = boxFarFaceElevation(box, screenX, screenY);
  const elevation = Math.max(exit, farFace, box.foot);
  const missed = elevation > exit;
  const hasVolume = box.top > box.foot;
  return { elevation, overhang: missed && (farFace > exit || hasVolume) };
}

export function boxSurfaceElevation(box: DepthBox, screenX: number, screenY: number): number {
  return boxSurface(box, screenX, screenY).elevation;
}

const DEPTH_COORD_LIMIT = 256;
const DEPTH_ELEV_LIMIT = 48;
export const DEPTH_MAX = 2 * DEPTH_COORD_LIMIT + HEIGHT_PER_LEVEL * DEPTH_ELEV_LIMIT;
export const DEPTH_MIN = -DEPTH_MAX;

export const DEPTH_STACK_BIAS = 0.002;

export const DEPTH_PLANE_BIAS = 0.0005;

export const DEPTH_PLANE_EAST_WEIGHT = 1 / 1024;

const MAX_ART_OVERHANG_CELLS = 4;

export const DEPTH_OVERHANG_BIAS = MAX_ART_OVERHANG_CELLS * CELL_SIZE * DEPTH_PLANE_BIAS;

export const DEPTH_LEAST_BODY = DEPTH_STACK_BIAS / RAY_DEPTH_ELEV / 2;

export const DEPTH_BIAS_PER_LEVEL = 64;

export function depthStackBias(z: number, stackIndex: number): number {
  return (z - MIN_LEVEL) * DEPTH_BIAS_PER_LEVEL + stackIndex;
}

export function snapToPixelCenter(v: number): number {
  return Math.floor(v) + 0.5;
}

export function planeDepthBias(box: DepthBox): number {
  return (box.southPx + box.eastPx * DEPTH_PLANE_EAST_WEIGHT) * DEPTH_PLANE_BIAS;
}

export function fragDepth(box: DepthBox, screenX: number, screenY: number, stackBias = 0): number {
  const px = snapToPixelCenter(screenX);
  const py = snapToPixelCenter(screenY);
  const surface = boxSurface(box, px, py);
  const d =
    rayDepth(px, py, surface.elevation) +
    stackBias * DEPTH_STACK_BIAS +
    planeDepthBias(box) +
    (surface.overhang ? DEPTH_OVERHANG_BIAS : 0);
  const normalized = (DEPTH_MAX - d) / (DEPTH_MAX - DEPTH_MIN);
  return Math.max(0, Math.min(1, normalized));
}
