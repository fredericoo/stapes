import { stackOcclusion } from "../lib/lighting";
import { type RoofCut, cutHides } from "../lib/levelVisibility";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { viewLevels } from "../lib/view";

function covers(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): boolean {
  return stackOcclusion(getStack(map, x, y, z), tilesById).sealsLevel;
}

export function isHiddenFromCamera(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
  viewerZ: number,
  cut: RoofCut | undefined,
): boolean {
  const top = viewLevels(viewerZ).z1;
  for (let z = at.z + 1; z <= top; z++) {
    const step = z - at.z;
    const x = at.x + step;
    const y = at.y + step;
    if (cutHides(cut, x, y, z)) continue;
    if (covers(map, tilesById, x, y, z)) return true;
  }

  for (let z = at.z + 1; z <= viewerZ; z++) {
    if (cutHides(cut, at.x, at.y, z)) continue;
    if (covers(map, tilesById, at.x, at.y, z)) return true;
  }
  return false;
}

export function isCellVisible(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
  viewerZ: number,
  cut: RoofCut | undefined,
): boolean {
  if (cutHides(cut, at.x, at.y, at.z)) return false;
  if (at.z === viewerZ) return true;
  return !isHiddenFromCamera(map, tilesById, at, viewerZ, cut);
}
