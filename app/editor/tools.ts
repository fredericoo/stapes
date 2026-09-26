import { getChunk, getStack, listChunkKeys } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";
import { parseCoordKey } from "../lib/types";

export function stacksEqual(a: PlacedTile[], b: PlacedTile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.tileId !== pb.tileId) return false;
    if ((pa.direction ?? undefined) !== (pb.direction ?? undefined)) return false;
    if ((pa.variant ?? undefined) !== (pb.variant ?? undefined)) return false;
  }
  return true;
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function occupiedBounds(map: MapFile, z: number): Bounds | null {
  let bounds: Bounds | null = null;
  for (const chunk of listChunkKeys(map, z)) {
    const cells = getChunk(map, z, chunk);
    for (const key in cells) {
      const { x, y } = parseCoordKey(key);
      if (!bounds) {
        bounds = { minX: x, maxX: x, minY: y, maxY: y };
        continue;
      }
      if (x < bounds.minX) bounds.minX = x;
      if (x > bounds.maxX) bounds.maxX = x;
      if (y < bounds.minY) bounds.minY = y;
      if (y > bounds.maxY) bounds.maxY = y;
    }
  }
  return bounds;
}

export function floodCoords(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): Array<{ x: number; y: number }> {
  const target = getStack(map, x, y, z);
  const bounds = target.length === 0 ? occupiedBounds(map, z) : null;
  if (target.length === 0 && !bounds) return [];

  const out: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [{ x, y }];

  while (queue.length > 0) {
    const pos = queue.pop()!;
    if (
      bounds &&
      (pos.x < bounds.minX || pos.x > bounds.maxX || pos.y < bounds.minY || pos.y > bounds.maxY)
    ) {
      return [];
    }
    const key = `${pos.x},${pos.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!stacksEqual(getStack(map, pos.x, pos.y, z), target)) continue;
    out.push(pos);
    queue.push(
      { x: pos.x - 1, y: pos.y },
      { x: pos.x + 1, y: pos.y },
      { x: pos.x, y: pos.y - 1 },
      { x: pos.x, y: pos.y + 1 },
    );
  }
  return out;
}
