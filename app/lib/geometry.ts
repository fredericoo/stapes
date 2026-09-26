import { CELL_SIZE, HEIGHT_PER_LEVEL, MIN_LEVEL } from "./types";

export const PX_PER_HEIGHT = CELL_SIZE / HEIGHT_PER_LEVEL;

/**
 * The elevation weight in ray depth. `HEIGHT_PER_LEVEL` is the geometric
 * constant; the `+0.5` breaks ties in favor of the higher surface when two
 * fragments would otherwise land at the same depth.
 */
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

/**
 * Not used for world tiles, which get per-pixel depth from {@link fragDepth}
 * instead. This survives only for the editor's overlay chrome, drawn with
 * `depthTest: false`, which needs a whole-sprite `renderOrder`.
 */
export function drawOrder(x: number, y: number, absElev: number, stackIndex: number): number {
  return y * 1_000_000_000 + x * 1_000_000 + absElev * 1_000 + stackIndex;
}

/**
 * `eastPx`/`southPx` are world pixels of the unshifted cell grid
 * (`(cell + 1) * CELL_SIZE`), not what {@link baseCellWorldOrigin} returns —
 * that origin already bakes in the elevation screen shift, which these
 * planes must not, since the shader recovers elevation from that shift.
 */
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

/**
 * The oblique projection puts `(x+1, y+1, elev+HEIGHT_PER_LEVEL)` on the same
 * screen pixel as `(x, y, elev)`, so `x + y + HEIGHT_PER_LEVEL*elev` is
 * constant along a view ray. This is that constant, in terms of the pixel a
 * fragment lands on and the elevation it depicts.
 */
export function rayDepth(screenX: number, screenY: number, elev: number): number {
  return (screenX + screenY) / CELL_SIZE + RAY_DEPTH_ELEV * elev;
}

/** The nearest elevation still inside the box: each visible face caps it, hence the min. */
function boxExitElevation(box: DepthBox, screenX: number, screenY: number): number {
  return Math.min(
    (box.eastPx - screenX) / PX_PER_HEIGHT,
    (box.southPx - screenY) / PX_PER_HEIGHT,
    box.top,
  );
}

/**
 * One cell of screen travel is one `HEIGHT_PER_LEVEL` of ray climb, so a far
 * face sits one level behind the corresponding near face.
 */
function boxFarFaceElevation(box: DepthBox, screenX: number, screenY: number): number {
  return (
    Math.max((box.eastPx - screenX) / PX_PER_HEIGHT, (box.southPx - screenY) / PX_PER_HEIGHT) -
    HEIGHT_PER_LEVEL
  );
}

/**
 * A ray that crosses the box exits through a visible face, which is the
 * surface. A ray that misses (art drawn outside the box's footprint) falls
 * back to whichever neighboring plane it would have crossed — the far-face
 * plane above the far faces, the foot plane under the foot — and is marked
 * `overhang` so {@link DEPTH_OVERHANG_BIAS} can win the resulting tie for the
 * art instead of losing it to the neighbor whose real face sits on that
 * plane.
 */
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

/**
 * The nudge applied per stack index to separate coplanar surfaces, such as a
 * character's feet on the floor it stands on. About 24 times the 24-bit
 * depth buffer's smallest step over `[DEPTH_MIN, DEPTH_MAX]` — enough to
 * order ties, far too small to reorder anything that is genuinely apart.
 */
export const DEPTH_STACK_BIAS = 0.002;

/**
 * Multiplier on a box's south/east edges that settles a coplanar tie between
 * two flat tiles (south wins, then east) instead of leaving it to depend on
 * merge order. Sized so one cell step beats a few stack indices while the
 * whole map stays under one elevation unit of {@link RAY_DEPTH_ELEV}.
 */
export const DEPTH_PLANE_BIAS = 0.0005;

export const DEPTH_PLANE_EAST_WEIGHT = 1 / 1024;

const MAX_ART_OVERHANG_CELLS = 4;

/**
 * Wins the tie {@link boxSurface} creates for art that misses its own box:
 * larger than {@link DEPTH_PLANE_BIAS} can accumulate across the widest
 * overhang allowed, and far smaller than one art pixel of ray depth, so it
 * can only ever break a tie, never reorder fragments that are genuinely
 * apart.
 */
export const DEPTH_OVERHANG_BIAS = MAX_ART_OVERHANG_CELLS * CELL_SIZE * DEPTH_PLANE_BIAS;

/**
 * Lifts a box just enough to count as having volume — half a stack index
 * once ray depth has weighted it, which is smaller than
 * {@link DEPTH_STACK_BIAS} can move anything, so it can only win a tie it
 * was already losing on a technicality.
 */
export const DEPTH_LEAST_BODY = DEPTH_STACK_BIAS / RAY_DEPTH_ELEV / 2;

/**
 * Must beat any in-level `stackIndex`, while keeping
 * `(levelSpan * this + maxIndex) * DEPTH_STACK_BIAS` under one elevation unit
 * of ray depth, so a single elevation unit still wins over the largest bias.
 */
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
