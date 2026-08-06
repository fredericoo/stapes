/** Pure helpers for paint tools. */

import { getStack } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";

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

/**
 * 4-connected flood of cells whose stack equals the start cell.
 * Empty start stacks yield no coords (no filling empty space).
 */
export function floodCoords(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): Array<{ x: number; y: number }> {
  const target = getStack(map, x, y, z);
  if (target.length === 0) return [];

  const out: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [{ x, y }];

  while (queue.length > 0) {
    const pos = queue.pop()!;
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
