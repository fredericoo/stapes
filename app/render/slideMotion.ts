import type { SlideSnapshot } from "../game/GameSession";
import { baseCellWorldOrigin, depthStackBias } from "../lib/geometry";
import { elevationAt, getStack, stackHeight } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type MapFile, type PlacedTile, type TileDef } from "../lib/types";
import { clumpExtentAt } from "./depthClump";
import type { TileMotion } from "./WorldRenderer";

function clumpHeight(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  const extent = clumpExtentAt(stack, stackIndex, tilesById);
  return extent.top - extent.foot;
}

export function slideTileMotions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  slide: SlideSnapshot,
  progress: number,
): TileMotion[] {
  const { object, from, count } = slide;
  const t = progress;

  const fromCenter = surfaceWorldCenter(map, tilesById, from);
  const toCenter = slotWorldCenter(map, tilesById, object, object.stackIndex);
  const visualX = Math.round(fromCenter.x + (toCenter.x - fromCenter.x) * t);
  const visualY = Math.round(fromCenter.y + (toCenter.y - fromCenter.y) * t);
  const ox = visualX - toCenter.x;
  const oy = visualY - toCenter.y;

  const originFoot = surfaceFootAbs(map, tilesById, from);
  const baseFoot = slotFootAbs(map, tilesById, object, object.stackIndex);
  const behind = (baseFoot - originFoot) * (1 - t);

  const boxX = from.x + (object.x - from.x) * t;
  const boxY = from.y + (object.y - from.y) * t;
  const originStackLen = getStack(map, from.x, from.y, from.z).length;
  const stack = getStack(map, object.x, object.y, object.z);

  const motions: TileMotion[] = [];
  for (let i = 0; i < count; i++) {
    const stackIndex = object.stackIndex + i;
    const placed = stack[stackIndex];
    if (!placed) continue;
    const foot = slotFootAbs(map, tilesById, object, stackIndex) - behind;
    motions.push({
      x: object.x,
      y: object.y,
      z: object.z,
      stackIndex,
      ox,
      oy,
      alsoDrawAtZ: from.z < object.z ? from.z : undefined,
      box: {
        x: boxX,
        y: boxY,
        foot,
        top: foot + clumpHeight(stack, stackIndex, tilesById),
        stackBias: Math.max(
          depthStackBias(from.z, originStackLen),
          depthStackBias(object.z, stackIndex),
        ),
      },
    });
  }
  return motions;
}

function slotFootAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
  stackIndex: number,
): number {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  return cell.z * HEIGHT_PER_LEVEL + elevationAt(stack, stackIndex, tilesById);
}

function surfaceFootAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
): number {
  return cell.z * HEIGHT_PER_LEVEL + stackHeight(getStack(map, cell.x, cell.y, cell.z), tilesById);
}

function slotWorldCenter(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
  stackIndex: number,
): { x: number; y: number } {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  const elev = elevationAt(stack, stackIndex, tilesById);
  return cellCenter(cell, elev);
}

function surfaceWorldCenter(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
): { x: number; y: number } {
  const elev = stackHeight(getStack(map, cell.x, cell.y, cell.z), tilesById);
  return cellCenter(cell, elev);
}

const CELL_CENTER_OFFSET_PX = 4;

function cellCenter(
  cell: { x: number; y: number; z: number },
  elev: number,
): { x: number; y: number } {
  const origin = baseCellWorldOrigin(cell.x, cell.y, cell.z, elev);
  return {
    x: origin.x + CELL_CENTER_OFFSET_PX,
    y: origin.y + CELL_CENTER_OFFSET_PX,
  };
}
