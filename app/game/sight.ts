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

    const lowerX = z < prevZ ? x : prevX;
    const lowerY = z < prevZ ? y : prevY;
    if (z !== prevZ && sealsAgainstVertical(map, tilesById, lowerX, lowerY, Math.max(z, prevZ))) {
      return false;
    }
    prevX = x;
    prevY = y;
    prevZ = z;

    if (i < steps && blocksSight(map, tilesById, x, y, z, eyeAt)) {
      return false;
    }
  }
  return true;
}
