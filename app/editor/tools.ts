/** Pure helpers for paint tools. */

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
  }
  return true;
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/** Box around every cell a level has, or null when the level is empty. */
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

/**
 * 4-connected flood of cells whose stack equals the start cell.
 *
 * A blank start cell floods too — painting the inside of an outline you just
 * drew is the whole point of the tool — but blank space has no far edge, so it
 * only counts as fillable while it stays inside the box around everything the
 * level already holds. Step outside that box and every cell beyond it is blank
 * as well, so the flood is walking into open world and would only stop when it
 * ran out of memory: that case fills nothing at all rather than some arbitrary
 * prefix of the void.
 *
 * The box is the exact test, not an approximation of one. A blank region that
 * never leaves it is enclosed by tiles on every side; one that leaves it can
 * reach any coordinate at all.
 */
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
      (pos.x < bounds.minX ||
        pos.x > bounds.maxX ||
        pos.y < bounds.minY ||
        pos.y > bounds.maxY)
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

export function rectCoords(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Array<{ x: number; y: number }> {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const out: Array<{ x: number; y: number }> = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      out.push({ x, y });
    }
  }
  return out;
}

/** Ellipse inscribed in the bounding box (inclusive). */
export function circleCoords(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Array<{ x: number; y: number }> {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2 + 0.5;
  const ry = (maxY - minY) / 2 + 0.5;
  const out: Array<{ x: number; y: number }> = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        out.push({ x, y });
      }
    }
  }
  return out;
}
