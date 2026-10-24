import type { SlideSnapshot } from "../game/GameSession";
import { slidePhases } from "../game/push";
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
  const { across, down } = slidePhases(slide.dropUnits, progress);

  /**
   * The column slides across at the height it left, then drops to where it
   * landed. `overEdge` is the point between the two: the landing cell, at the
   * surface the column was pushed off.
   */
  const fromCenter = surfaceWorldCenter(map, tilesById, from);
  const toCenter = slotWorldCenter(map, tilesById, object, object.stackIndex);
  const originFoot = surfaceFootAbs(map, tilesById, from);
  const overEdge = cellCenter(
    { x: object.x, y: object.y, z: from.z },
    originFoot - from.z * HEIGHT_PER_LEVEL,
  );
  const visualX = Math.round(
    fromCenter.x + (overEdge.x - fromCenter.x) * across + (toCenter.x - overEdge.x) * down,
  );
  const visualY = Math.round(
    fromCenter.y + (overEdge.y - fromCenter.y) * across + (toCenter.y - overEdge.y) * down,
  );
  const ox = visualX - toCenter.x;
  const oy = visualY - toCenter.y;

  const baseFoot = slotFootAbs(map, tilesById, object, object.stackIndex);
  const behind = (baseFoot - originFoot) * (1 - down);

  const boxX = from.x + (object.x - from.x) * across;
  const boxY = from.y + (object.y - from.y) * across;
  const originStackLen = getStack(map, from.x, from.y, from.z).length;
  const stack = getStack(map, object.x, object.y, object.z);
  const drawZ = slideDrawLevel(from.z, object.z, baseFoot - behind);

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
      alsoDrawAtZ: drawZ === object.z ? undefined : drawZ,
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

/**
 * The level a sliding column is drawn on, and so lit by. A climb stays on the
 * level it left until it arrives. A drop is already on its landing level on the
 * board, so without this it would cross the floor above lit by the pit's light
 * map; it is drawn on whichever level its foot is passing through instead, as
 * a falling body is relocated level by level.
 */
function slideDrawLevel(fromZ: number, toZ: number, footAbs: number): number {
  if (fromZ < toZ) return fromZ;
  return Math.min(fromZ, Math.max(toZ, Math.floor(footAbs / HEIGHT_PER_LEVEL)));
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
