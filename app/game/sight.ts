import { stackBlockHeight, stackOcclusion } from "../lib/lighting";
import { getStack } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type Coord, type MapFile, type TileDef } from "../lib/types";

function solidTopAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): number {
  return z * HEIGHT_PER_LEVEL + stackBlockHeight(getStack(map, x, y, z), tilesById);
}

function eyeAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
  eyeHeight: number,
): number {
  return solidTopAbs(map, tilesById, at.x, at.y, at.z) + eyeHeight;
}

function blocksSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
  eyeAt: number,
): boolean {
  const blockH = stackBlockHeight(getStack(map, x, y, z), tilesById);
  /**
   * Nothing solid standing here, so there is nothing to be behind. Load-
   * bearing rather than an optimisation: without it an empty cell reports the
   * floor of its own level as a top, and a look travelling upward through
   * open air is stopped by the air.
   */
  if (blockH === 0) return false;
  return z * HEIGHT_PER_LEVEL + blockH >= eyeAt;
}

function sealsAgainstVertical(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): boolean {
  return stackOcclusion(getStack(map, x, y, z), tilesById).sealsLevel;
}

export function hasLineOfSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: Coord,
  to: Coord,
  eyeHeight: number = HEIGHT_PER_LEVEL,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return true;

  const eyeAt = eyeAbs(map, tilesById, from, eyeHeight);

  let prevX = from.x;
  let prevY = from.y;
  let prevZ = from.z;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(from.x + dx * t);
    const y = Math.round(from.y + dy * t);
    const z = Math.round(from.z + dz * t);

    /**
     * A step up crosses the plane in the column being left; a step down
     * crosses it in the column being entered. Reading it off the wrong
     * column for either direction lets a look climb through a ceiling, or
     * stops a look down at the floor its own target is standing on.
     */
    const lowerX = z < prevZ ? x : prevX;
    const lowerY = z < prevZ ? y : prevY;
    if (z !== prevZ && sealsAgainstVertical(map, tilesById, lowerX, lowerY, Math.max(z, prevZ))) {
      return false;
    }
    prevX = x;
    prevY = y;
    prevZ = z;

    /**
     * The endpoints are never tested sideways: the last step is the target
     * cell itself, and a body standing inside its own doorway must not be
     * invisible in it.
     */
    if (i < steps && blocksSight(map, tilesById, x, y, z, eyeAt)) {
      return false;
    }
  }
  return true;
}
