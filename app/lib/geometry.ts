import { CELL_SIZE, HEIGHT_PER_LEVEL, MIN_LEVEL } from "./types";

/** 1 height unit = 4px up-left on screen (full level = 8px = one cell). */
export const PX_PER_HEIGHT = CELL_SIZE / HEIGHT_PER_LEVEL;

/**
 * Elev weight in ray-depth. Geometric constant is HEIGHT_PER_LEVEL
 * (one cell step matches that many height units); +0.5 biases toward
 * higher surfaces when separating coplanar-ish fragments.
 */
export const RAY_DEPTH_ELEV = HEIGHT_PER_LEVEL + 0.5;

/**
 * Absolute foot elevation for a tile: level floor + in-stack elevation.
 * Matches gameplay (`absoluteStandingElevation`) so overflow stacks sort
 * against superior-level tiles by height, not by level membership.
 */
export function absoluteElevation(z: number, elevation: number): number {
  return z * HEIGHT_PER_LEVEL + elevation;
}

/** Full level (2 height units) = 8px = one cell. */
export function levelScreenOffset(z: number): { x: number; y: number } {
  return { x: -CELL_SIZE * z, y: -CELL_SIZE * z };
}

/** Elevation within a stack: e height units → 4e px up-left. */
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
 *
 * World tiles do NOT use this — they get per-pixel depth (see {@link fragDepth}).
 * It survives for the editor's overlay chrome, which is drawn with `depthTest:
 * false` and needs a whole-sprite `renderOrder`.
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
 * A placed tile as a solid box in world space: the cell footprint
 * [x, x+1] x [y, y+1] extruded from `foot` to `top` height units.
 *
 * Edges are stored as world pixels of the *unshifted* cell grid — raw
 * `(cell + 1) * CELL_SIZE`, NOT what {@link baseCellWorldOrigin} returns. The
 * origin bakes in the -PX_PER_HEIGHT*elevation screen shift; these planes must
 * not, since the shader recovers elevation *from* that shift.
 */
export type DepthBox = {
  eastPx: number;
  southPx: number;
  foot: number;
  top: number;
};

/** Box for a tile whose base cell is (x, y), standing from `foot` to `top`. */
export function depthBox(
  x: number,
  y: number,
  foot: number,
  top: number,
): DepthBox {
  return {
    eastPx: (x + 1) * CELL_SIZE,
    southPx: (y + 1) * CELL_SIZE,
    foot,
    top,
  };
}

/**
 * Ray depth of a world point, larger = nearer the camera.
 *
 * The oblique projection puts (x+1, y+1, elev+HEIGHT_PER_LEVEL) on the same
 * screen pixel as (x, y, elev), so `x + y + HEIGHT_PER_LEVEL*elev` is constant
 * along a view ray. Substituting the projection
 * (screenPx = CELL_SIZE*cell - PX_PER_HEIGHT*elev) gives this in terms of the
 * pixel a fragment lands on plus the elevation it depicts.
 */
export function rayDepth(screenX: number, screenY: number, elev: number): number {
  return (screenX + screenY) / CELL_SIZE + RAY_DEPTH_ELEV * elev;
}

/**
 * Elevation of the box surface seen at a screen pixel — the box's three visible
 * faces (top, south, east) resolved as one value.
 *
 * Along a view ray elevation rises as it travels away from the camera, so the
 * nearest surface is the *highest* elevation still inside the box: each face
 * caps it, hence the min. Rays that miss the box entirely (sprite art drawn
 * outside its logical footprint, e.g. a tree canopy) clamp to `foot`.
 */
export function boxSurfaceElevation(
  box: DepthBox,
  screenX: number,
  screenY: number,
): number {
  const eastFace = (box.eastPx - screenX) / PX_PER_HEIGHT;
  const southFace = (box.southPx - screenY) / PX_PER_HEIGHT;
  const surface = Math.min(eastFace, southFace, box.top);
  return Math.max(box.foot, Math.min(surface, box.top));
}

/**
 * Ray depths are normalised into the [0, 1] window-depth range against these
 * bounds. Generous enough for maps far larger than we ship (levels are capped
 * at +/-8, so +/-48 covers every elevation including overflow stacks).
 */
const DEPTH_COORD_LIMIT = 256;
const DEPTH_ELEV_LIMIT = 48;
export const DEPTH_MAX =
  2 * DEPTH_COORD_LIMIT + HEIGHT_PER_LEVEL * DEPTH_ELEV_LIMIT;
export const DEPTH_MIN = -DEPTH_MAX;

/**
 * Nudge, in ray-depth units, applied per stack-bias unit.
 *
 * Coplanar surfaces are the one case geometry can't separate: a character's
 * feet sit exactly on the floor plane it stands on. ~24x the 24-bit depth
 * buffer's step over [DEPTH_MIN, DEPTH_MAX], and far too small to reorder
 * anything that is genuinely apart.
 */
export const DEPTH_STACK_BIAS = 0.002;

/**
 * Per-level stride for {@link depthStackBias}. Must beat any in-level
 * stackIndex, but keep
 * `(levelSpan * stride + maxIndex) * DEPTH_STACK_BIAS < RAY_DEPTH_ELEV`
 * so one elev unit of ray depth still wins over the largest bias.
 */
export const DEPTH_BIAS_PER_LEVEL = 64;

/** Bias so higher levels win coplanar ties; within a level, higher stackIndex. */
export function depthStackBias(z: number, stackIndex: number): number {
  return (z - MIN_LEVEL) * DEPTH_BIAS_PER_LEVEL + stackIndex;
}

/**
 * Centre of the art pixel a point falls in.
 *
 * Depth is sampled here rather than at the raw fragment position because a
 * fragment is finer than an art pixel once zoomed — at 4x, sixteen fragments
 * share one texel. Sampling per fragment lets a depth crossing pass *through* a
 * texel, drawing a smooth diagonal seam across pixel art that has no business
 * containing one. Snapping first gives every fragment of a texel the same
 * depth, so a crossing can only ever land on a texel boundary.
 */
export function snapToPixelCenter(v: number): number {
  return Math.floor(v) + 0.5;
}

/**
 * Window depth ([0, 1], smaller = nearer, matching the default GL_LESS test)
 * for the fragment of `box` landing on a screen pixel.
 *
 * Mirrors the GLSL in `app/render/worldQuads.ts` — the reference the tests
 * assert against.
 */
export function fragDepth(
  box: DepthBox,
  screenX: number,
  screenY: number,
  stackBias = 0,
): number {
  const px = snapToPixelCenter(screenX);
  const py = snapToPixelCenter(screenY);
  const elev = boxSurfaceElevation(box, px, py);
  const d = rayDepth(px, py, elev) + stackBias * DEPTH_STACK_BIAS;
  const normalized = (DEPTH_MAX - d) / (DEPTH_MAX - DEPTH_MIN);
  return Math.max(0, Math.min(1, normalized));
}
