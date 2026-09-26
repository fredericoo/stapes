import { footElevation, terrainHeight } from "../lib/mapData";
import type { PlacedTile, TileDef } from "../lib/types";

export type DepthExtent = { foot: number; top: number };

const EMPTY: DepthExtent = { foot: 0, top: 0 };

export function clumpExtents(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): DepthExtent[] {
  const out: DepthExtent[] = new Array(stack.length);
  if (stack.length === 0) return out;

  const feet: number[] = new Array(stack.length);
  const tops: number[] = new Array(stack.length);
  let elev = 0;
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i]!;
    elev = footElevation(elev, placed);
    feet[i] = elev;
    tops[i] = elev + (tilesById[placed.tileId]?.height ?? 0);
    elev += terrainHeight(placed, tilesById);
  }

  let start = 0;
  let foot = feet[0]!;
  let top = tops[0]!;
  const close = (end: number) => {
    const extent: DepthExtent = { foot, top };
    for (let i = start; i < end; i++) out[i] = extent;
  };

  for (let i = 1; i < stack.length; i++) {
    if (feet[i]! < top) {
      foot = Math.min(foot, feet[i]!);
      top = Math.max(top, tops[i]!);
      continue;
    }
    close(i);
    start = i;
    foot = feet[i]!;
    top = tops[i]!;
  }
  close(stack.length);
  return out;
}

export function clumpExtentAt(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): DepthExtent {
  return clumpExtents(stack, tilesById)[stackIndex] ?? EMPTY;
}

export function clumpExtentOnArrival(
  stack: PlacedTile[],
  arriving: TileDef | undefined,
  tilesById: Record<string, TileDef>,
): DepthExtent {
  let foot = 0;
  for (const placed of stack) {
    foot = footElevation(foot, placed) + terrainHeight(placed, tilesById);
  }
  let top = foot + (arriving?.height ?? 0);

  const extents = clumpExtents(stack, tilesById);
  const last = extents[extents.length - 1];
  if (last && foot < last.top) {
    foot = Math.min(foot, last.foot);
    top = Math.max(top, last.top);
  }
  return { foot, top };
}

const STEP_CLUMP_AT = 0.5;

export function steppingClumpHeight(
  origin: { stack: PlacedTile[]; stackIndex: number },
  destination: { stack: PlacedTile[]; arriving: TileDef | undefined },
  progress: number,
  tilesById: Record<string, TileDef>,
): number {
  const extent =
    progress < STEP_CLUMP_AT
      ? clumpExtentAt(origin.stack, origin.stackIndex, tilesById)
      : clumpExtentOnArrival(destination.stack, destination.arriving, tilesById);
  return extent.top - extent.foot;
}
