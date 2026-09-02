import type { SlideSnapshot } from "../game/GameSession";
import { baseCellWorldOrigin, depthStackBias } from "../lib/geometry";
import { elevationAt, getStack, stackHeight } from "../lib/mapData";
import {
  HEIGHT_PER_LEVEL,
  type MapFile,
  type PlacedTile,
  type TileDef,
} from "../lib/types";
import { clumpExtentAt } from "./depthClump";
import type { TileMotion } from "./WorldRenderer";

/**
 * Where the sprites of a shoved column are drawn part-way through the slide.
 *
 * Pure, and out here rather than on the renderer for the reason `./fallAnchor`
 * is: the arithmetic is the whole of the behaviour and it wants a test, while
 * the renderer around it wants a canvas.
 *
 * **A column travels rigidly.** The push is already committed — every tile is
 * at its destination slot in the map — so this drags the sprites *back* towards
 * the cell they left, by an offset that decays to zero. Every rider is exactly
 * as far from home as the crate under it, which is why one offset and one
 * height delta serve the whole group: the only thing that differs between them
 * is the slot each is anchored at.
 */


/**
 * How tall the slot's clump stands. A shoved column's members rest on each
 * other rather than in each other, so this is each tile's own height — until
 * one is shoved into something intangible, which is the case it exists for.
 */
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

  // The column has left `from`, so its old surface is that stack's top now; at
  // `object` the bottom of it is in the stack, so its surface is what is under
  // that slot.
  const fromCenter = surfaceWorldCenter(map, tilesById, from);
  const toCenter = slotWorldCenter(map, tilesById, object, object.stackIndex);
  const visualX = Math.round(fromCenter.x + (toCenter.x - fromCenter.x) * t);
  const visualY = Math.round(fromCenter.y + (toCenter.y - fromCenter.y) * t);
  const ox = visualX - toCenter.x;
  const oy = visualY - toCenter.y;

  const originFoot = surfaceFootAbs(map, tilesById, from);
  const baseFoot = slotFootAbs(map, tilesById, object, object.stackIndex);
  // How far below its committed home the whole column still is.
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

/**
 * Absolute foot elevation of a stack slot, counting only what is *under* it.
 *
 * `./fallAnchor`'s `standingFootAbs` answers the same question as "the cell
 * minus me", which is the same answer for a mover on top of its stack — every
 * walking and falling body. A shoved column is the one case that is not: the
 * crate riding another crate would be lifted by the height of the crate above
 * it as well as the one below.
 */
function slotFootAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
  stackIndex: number,
): number {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  return cell.z * HEIGHT_PER_LEVEL + elevationAt(stack, stackIndex, tilesById);
}

/** Absolute elevation of a cell's standing surface — everything in it. */
function surfaceFootAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
): number {
  return (
    cell.z * HEIGHT_PER_LEVEL +
    stackHeight(getStack(map, cell.x, cell.y, cell.z), tilesById)
  );
}

/** World-pixel centre of a stack slot's own footing. @see slotFootAbs */
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

/** World-pixel centre of a cell's standing surface (scenery only). */
function surfaceWorldCenter(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: { x: number; y: number; z: number },
): { x: number; y: number } {
  const elev = stackHeight(getStack(map, cell.x, cell.y, cell.z), tilesById);
  return cellCenter(cell, elev);
}

/** Half a cell in from the origin, which is where a tile's foot is measured. */
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
