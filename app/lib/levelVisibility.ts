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
export const VIEW_RADIUS = 2;

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

function buildOcclusion(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Map<string, CellOcclusion> {
  const occlusion = new Map<string, CellOcclusion>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const [ck, stack] of Object.entries(level)) {
      if (!stack.length) continue;
      const { x, y } = parseCoordKey(ck);
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, z), occ);
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
 * True when any cell within Euclidean `radius` of `view` has same-floor LOS
 * and content on a higher level — callers should then hide all z > view.z.
 */
export function levelsAboveShouldHide(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  radius = VIEW_RADIUS,
): boolean {
  const occlusion = buildOcclusion(map, tilesById);
  const r2 = radius * radius;
  const span = Math.ceil(radius);

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx * dx + dy * dy > r2) continue;

      const x = view.x + dx;
      const y = view.y + dy;
      if (!hasContentAbove(map, x, y, view.z)) continue;

      if (x === view.x && y === view.y) return true;

      const transmission = rayTransmission(
        view.x,
        view.y,
        view.z,
        x,
        y,
        view.z,
        occlusion,
      );
      if (transmission >= TRANSMISSION_EPSILON) return true;
    }
  }

  return false;
}
