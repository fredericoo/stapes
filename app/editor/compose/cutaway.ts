import { getStack, setStacks, type StackEdit } from "../../lib/mapData";
import type { MapFile } from "../../lib/types";
import type { Bounds } from "../generator";

/**
 * The map with everything above `level` taken off the cells of `bounds`, so
 * a storey of a building can be seen from above. Only the picture is cut:
 * the editor draws this map and keeps building the whole one.
 */
export function cutAbove(map: MapFile, bounds: Bounds, level: number): MapFile {
  const edits: StackEdit[] = [];
  for (const key of Object.keys(map.levels)) {
    const z = Number(key);
    if (z <= level) continue;
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        if (getStack(map, x, y, z).length > 0) edits.push({ x, y, z, stack: [] });
      }
    }
  }
  return setStacks(map, edits);
}
