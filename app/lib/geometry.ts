import { CELL_SIZE, HEIGHT_PER_LEVEL, MIN_LEVEL } from "./types";

/** 1 height unit = 2px up-left on screen (full level = 8px = one cell). */
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

/** Full level ({@link HEIGHT_PER_LEVEL} height units) = 8px = one cell. */
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
export function rayDepth(
  screenX: number,
  screenY: number,
  elev: number,
): number {
  return (screenX + screenY) / CELL_SIZE + RAY_DEPTH_ELEV * elev;
}

/**
 * Elevation at which a ray *leaves* the box — the near side, where its three
 * visible faces (top, south, east) are.
 *
 * Along a view ray elevation rises as it travels away from the camera, so the
 * nearest surface is the *highest* elevation still inside the box: each face
 * caps it, hence the min.
 */
function boxExitElevation(
  box: DepthBox,
  screenX: number,
  screenY: number,
): number {
  return Math.min(
    (box.eastPx - screenX) / PX_PER_HEIGHT,
    (box.southPx - screenY) / PX_PER_HEIGHT,
    box.top,
  );
}

/**
 * Elevation at which a ray reaches the box's far side — its north and west
 * faces, where a ray travelling away from the camera goes in.
 *
 * One cell of screen travel is {@link HEIGHT_PER_LEVEL} height units of ray
 * climb, so the far faces are the near ones a cell back.
 */
function boxFarFaceElevation(
  box: DepthBox,
  screenX: number,
  screenY: number,
): number {
  return (
    Math.max(
      (box.eastPx - screenX) / PX_PER_HEIGHT,
      (box.southPx - screenY) / PX_PER_HEIGHT,
    ) - HEIGHT_PER_LEVEL
  );
}

/**
 * Elevation of the box surface seen at a screen pixel, and whether the ray
 * found one at all.
 *
 * A ray that crosses the box exits through one of its visible faces, and that
 * exit is the surface. A ray that *misses* — every sprite has some, because art
 * is authored in a multi-cell slot while the box is one cell of footprint by
 * its declared height — has no surface of its own, and falls back to the
 * nearest plane the box does define. Which way it missed decides which:
 *
 * - past the far (north/west) faces, i.e. art hanging up-left, over the cells
 *   *behind* it: the far-face plane, where the ray would have gone in had the
 *   box been deep enough to catch it.
 * - under the foot, i.e. art hanging down-right, over the cells *in front* of
 *   it: the foot plane.
 *
 * Either plane is exactly where some neighbouring cell's own face already is,
 * so the art ties with that neighbour at every shared pixel, and the tie is
 * settled per pixel by {@link planeDepthBias} — which loses the art along a
 * diagonal rather than losing it cleanly. `overhang` marks both kinds of miss
 * so {@link DEPTH_OVERHANG_BIAS} can settle those ties for the art instead.
 * Depth stays continuous across the silhouette's edge, since box and plane
 * agree there.
 *
 * Deciding the down-right tie for the art is safe because the bias only ever
 * settles ties: art on the foot plane still loses to anything in the cell in
 * front whose surface stands above the foot — a wall, a crate, a tuft of grass,
 * a raised floor. What it now wins is the coplanar case, and a surface coplanar
 * with the foot one cell nearer is the same flat ground the tile is standing
 * on. A rat's tail hanging into that cell belongs in front of it.
 *
 * That last argument needs the box to have a body, so the down-right rescue is
 * only for boxes that have one. A flat tile declares no volume above the floor,
 * so art it draws past its own foot is more floor, and two coplanar floors are
 * exactly what painter order is for — the more southern one is nearer. Flat
 * tiles are therefore left exactly as they were: rescued where they miss past
 * the far faces, losing the tie where they miss under the foot.
 *
 * Clamping to the box in both directions is what this replaces, and it lost
 * art: overhang up-left claimed the top face, so a one-pixel outline sticking
 * out past the silhouette was beaten by any neighbour whose real surface was
 * there — the bite out of a crate's top edge — and a deer's head, drawn well
 * outside its own footprint, sorted as if lying on the floor.
 */
export function boxSurface(
  box: DepthBox,
  screenX: number,
  screenY: number,
): { elevation: number; overhang: boolean } {
  const exit = boxExitElevation(box, screenX, screenY);
  const farFace = boxFarFaceElevation(box, screenX, screenY);
  const elevation = Math.max(exit, farFace, box.foot);
  // A ray that left through a face lands *on* its exit elevation, so anything
  // higher means no face was crossed and a fallback plane won. Which plane
  // decides whether the art gets rescued: the far face always, the foot only
  // for a box with volume.
  const missed = elevation > exit;
  const hasVolume = box.top > box.foot;
  return { elevation, overhang: missed && (farFace > exit || hasVolume) };
}

/** The elevation half of {@link boxSurface}. */
export function boxSurfaceElevation(
  box: DepthBox,
  screenX: number,
  screenY: number,
): number {
  return boxSurface(box, screenX, screenY).elevation;
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
 * Multiplier on the box's south/east edges for coplanar cross-cell ties.
 *
 * Multi-cell sprites (base ≠ corner) overhang neighbouring cells. At a shared
 * screen pixel two flat tiles can resolve the same {@link boxSurfaceElevation},
 * so ray depth alone is a coin flip — merge order then looks "random". This
 * bias restores painter order: south, then east, in front. Sized so one cell
 * step (~{@link CELL_SIZE} × this) beats a few stack indices, while the whole
 * map stays under one elev unit of {@link RAY_DEPTH_ELEV}.
 */
export const DEPTH_PLANE_BIAS = 0.0005;

/** East contributes far less than south (south-major, matching {@link drawOrder}). */
export const DEPTH_PLANE_EAST_WEIGHT = 1 / 1024;

/** Widest a sprite's art reaches past its own cell, in cells. */
const MAX_ART_OVERHANG_CELLS = 4;

/**
 * Forward nudge, in ray-depth units, for a fragment whose ray misses its box —
 * art drawn outside its own silhouette.
 *
 * Overhanging art has no geometry to sort by, so {@link boxSurface} lands it on
 * the plane between its cell and the next, which is exactly where the
 * neighbour's own face is. The two then tie at every shared pixel and the plane
 * bias settles it south-first, which loses the art whenever the neighbour is the
 * more southern cell: a deer's head, drawn hanging over the wall corner it is
 * standing beside, was swallowed by that corner, and a rat's tail, drawn
 * hanging into the cell in front, was bitten diagonally in half by the floor
 * there.
 *
 * This decides such ties for the art instead. It sits between the two scales it
 * has to separate — larger than the plane bias can accumulate across the widest
 * art we allow, and far smaller than one art pixel of ray depth (1/CELL_SIZE) —
 * so it can only ever break a tie, never reorder fragments that are genuinely
 * apart. Two overhangs meeting both carry it, so they still settle by painter
 * order between themselves.
 */
export const DEPTH_OVERHANG_BIAS =
  MAX_ART_OVERHANG_CELLS * CELL_SIZE * DEPTH_PLANE_BIAS;

/**
 * The least body a box can declare and still count as having one.
 *
 * {@link boxSurface} rescues art hanging down-right over the cells in front
 * only for a box with volume, because a *flat* tile's art past its own foot is
 * more floor and two coplanar floors are what painter order is for. That test —
 * `top > foot` — is the only way the four numbers of a {@link DepthBox} can say
 * "this is an object standing on the floor rather than more of the floor", so
 * anything that is an object and happens to declare no height has to say it
 * with a body.
 *
 * Half a stack index once ray depth has weighted it, which is what makes it
 * safe: {@link DEPTH_STACK_BIAS} is the smallest step anything else here moves
 * in, so a box lifted by this cannot overtake something one stack index above it
 * — it can only win a tie it was already losing on a technicality. The rescue it
 * unlocks is worth far more than the lift: {@link DEPTH_OVERHANG_BIAS} is forty
 * times larger.
 *
 * Used by `../render/WorldRenderer` for a pile, whose sprites are spread across
 * their cell and therefore hang over the cells around it — see
 * `../render/pileLayout`. Nothing else needs it yet, because nothing else draws
 * a flat item anywhere but dead centre.
 */
export const DEPTH_LEAST_BODY = DEPTH_STACK_BIAS / RAY_DEPTH_ELEV / 2;

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
/** South-then-east coplanar nudge from a depth box's footprint edges. */
export function planeDepthBias(box: DepthBox): number {
  return (
    (box.southPx + box.eastPx * DEPTH_PLANE_EAST_WEIGHT) * DEPTH_PLANE_BIAS
  );
}

export function fragDepth(
  box: DepthBox,
  screenX: number,
  screenY: number,
  stackBias = 0,
): number {
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
