import { getStack } from "./mapData";
import {
  type CellOcclusion,
  rayTransmission,
  stackOcclusion,
} from "./lighting";
import type { MapFile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
} from "./types";

/** Euclidean cell radius around the view anchor for roof-hide checks. */
export const VIEW_RADIUS = 2.5;

const TRANSMISSION_EPSILON = 1e-3;

export type ViewAnchor = { x: number; y: number; z: number };

/** Minimal snapshot shape — satisfied by GameSnapshot. */
export type ViewAnchorSnapshot = {
  player: { x: number; y: number; z: number };
  walk: { to: { x: number; y: number; z: number } } | null;
  fall: { landingAbs: number } | null;
};

function cellKey(x: number, y: number, z: number): string {
  return `${z}:${coordKey(x, y)}`;
}

/** Map level for feet at absolute elevation — matches game/gravity cellForFeetAbs. */
function levelForFeetAbs(feetAbs: number): number {
  let z = Math.floor(feetAbs / HEIGHT_PER_LEVEL);
  if (z < MIN_LEVEL) z = MIN_LEVEL;
  if (z > MAX_LEVEL) z = MAX_LEVEL;
  return z;
}

/**
 * Where level-visibility is evaluated from: walk destination while walking,
 * landing level while falling, otherwise the committed player cell.
 */
export function viewAnchorFromSnapshot(snap: ViewAnchorSnapshot): ViewAnchor {
  if (snap.walk) {
    return { x: snap.walk.to.x, y: snap.walk.to.y, z: snap.walk.to.z };
  }
  if (snap.fall) {
    return {
      x: snap.player.x,
      y: snap.player.y,
      z: levelForFeetAbs(snap.fall.landingAbs),
    };
  }
  return { x: snap.player.x, y: snap.player.y, z: snap.player.z };
}

/**
 * Same occlusion model as lighting: light-passing tiles are ignored, height
 * maps to opacity, full walls seal the ray.
 */
/**
 * Occluders the roof-cut probe can consult: the anchor's own level, within
 * `span` cells of it.
 *
 * That is the whole reachable set — {@link hideRayClear} rays on a single level
 * between two points inside the radius, so the walk cannot leave the box. This
 * runs every frame, and sweeping the world to look at a handful of cells around
 * the player put the map's size into the frame budget.
 */
function buildOcclusion(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  span: number,
): Map<string, CellOcclusion> {
  const occlusion = new Map<string, CellOcclusion>();
  const level = map.levels[levelKey(view.z)];
  if (!level) return occlusion;

  for (let y = view.y - span; y <= view.y + span; y++) {
    for (let x = view.x - span; x <= view.x + span; x++) {
      const stack = level[coordKey(x, y)];
      if (!stack?.length) continue;
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, view.z), occ);
      }
    }
  }
  return occlusion;
}

function hasContentAbove(
  map: MapFile,
  x: number,
  y: number,
  viewZ: number,
): boolean {
  for (let z = viewZ + 1; z <= MAX_LEVEL; z++) {
    if (getStack(map, x, y, z).length > 0) return true;
  }
  return false;
}

/**
 * Same-floor LOS for roof-hide, matching light: intermediate cells attenuate
 * by opacity, and a fully opaque destination (solid wall) blocks looking into
 * that cell. Light-passing tiles (windows) stay see-through.
 */
function hideRayClear(
  x0: number,
  y0: number,
  z: number,
  x1: number,
  y1: number,
  occlusion: Map<string, CellOcclusion>,
): boolean {
  if (x0 === x1 && y0 === y1) return true;

  const transmission = rayTransmission(x0, y0, z, x1, y1, z, occlusion);
  if (transmission < TRANSMISSION_EPSILON) return false;

  // rayTransmission skips the destination; a solid wall on the probe cell
  // still means you cannot look through it into content above.
  const dest = occlusion.get(cellKey(x1, y1, z));
  if (dest && dest.opacity >= 1 - TRANSMISSION_EPSILON) return false;

  return true;
}

/**
 * True when any cell within Euclidean `radius` of `view` has same-floor LOS
 * and content on a higher level — callers should then hide all z > view.z.
 */
export function levelsAboveShouldHide(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  radius = VIEW_RADIUS,
): boolean {
  const r2 = radius * radius;
  const span = Math.ceil(radius);
  const occlusion = buildOcclusion(map, tilesById, view, span);

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx * dx + dy * dy > r2) continue;

      const x = view.x + dx;
      const y = view.y + dy;
      if (!hasContentAbove(map, x, y, view.z)) continue;

      if (hideRayClear(view.x, view.y, view.z, x, y, occlusion)) return true;
    }
  }

  return false;
}
