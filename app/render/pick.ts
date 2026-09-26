import { absoluteElevation, baseCellWorldOrigin, drawOrder, screenToCoord } from "../lib/geometry";
import { coveredBySomething } from "../game/affordances";
import type { ObjectRef } from "../game/GameSession";
import { isBattler } from "../lib/battler";
import { resolveDialog } from "../lib/dialog";
import { isInteractive } from "../lib/interactions";
import { type RoofCut, cutHides } from "../lib/levelVisibility";
import { elevationAt, getStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { CELL_SIZE, MAX_LEVEL, MIN_LEVEL } from "../lib/types";

export function footRect(
  x: number,
  y: number,
  z: number,
): { x: number; y: number; w: number; h: number } {
  const origin = baseCellWorldOrigin(x, y, z, 0);
  return { x: origin.x, y: origin.y, w: CELL_SIZE, h: CELL_SIZE };
}

export type PickContext = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  camera: { x: number; y: number };
  zoom: number;
};

function candidateIn(
  stack: readonly PlacedTile[],
  tilesById: Record<string, TileDef>,
  accepts: ((def: TileDef) => boolean) | undefined,
  isActionable: (stackIndex: number) => boolean,
): { stackIndex: number; actionable: boolean } | null {
  let topmost = -1;

  for (let i = stack.length - 1; i >= 0; i--) {
    if (coveredBySomething(stack, i, tilesById)) break;
    const placed = stack[i];
    if (!placed) break;
    const def = tilesById[placed.tileId];
    if (!def) break;
    if (accepts && !accepts(def)) continue;
    if (isActionable(i)) return { stackIndex: i, actionable: true };
    if (topmost < 0) topmost = i;
  }

  return topmost < 0 ? null : { stackIndex: topmost, actionable: false };
}

/**
 * Tests the foot square of each level's cell under the pointer, not the sprite's
 * bounds, so tall art does not take clicks meant for what stands behind it.
 */
function pickTopAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  opts: {
    centerZ: number;
    levelSlack: number;
    cut?: RoofCut;
    accepts?: (def: TileDef) => boolean;
    isActionable?: (ref: ObjectRef) => boolean;
  },
): ObjectRef | null {
  const zMax = Math.min(MAX_LEVEL, opts.centerZ + opts.levelSlack);
  const zMin = Math.max(MIN_LEVEL, opts.centerZ - opts.levelSlack);

  let best: ObjectRef | null = null;
  let bestActionable = false;
  let bestOrder = -Infinity;

  for (let z = zMin; z <= zMax; z++) {
    const { x, y } = screenToCoord(screenX, screenY, ctx.zoom, ctx.camera.x, ctx.camera.y, z);

    if (cutHides(opts.cut, x, y, z)) continue;

    const stack = getStack(ctx.map, x, y, z);
    const candidate = candidateIn(
      stack,
      ctx.tilesById,
      opts.accepts,
      (i) => opts.isActionable?.({ x, y, z, stackIndex: i }) ?? false,
    );
    if (!candidate) continue;

    const { stackIndex, actionable } = candidate;
    const ref: ObjectRef = { x, y, z, stackIndex };
    const order = drawOrder(
      x,
      y,
      absoluteElevation(z, elevationAt(stack, stackIndex, ctx.tilesById)),
      stackIndex,
    );
    if (best && !outranks(actionable, order, bestActionable, bestOrder)) {
      continue;
    }

    best = ref;
    bestActionable = actionable;
    bestOrder = order;
  }

  return best;
}

export function pickInteractiveAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
  isActionable: (ref: ObjectRef) => boolean = () => false,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    accepts: isInteractive,
    isActionable,
  });
}

export function pickBodyAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    accepts: isBody,
  });
}

function isBody(def: TileDef): boolean {
  return isBattler(def) || resolveDialog(def) !== null;
}

export function pickTileAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
  cut?: RoofCut,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    cut,
  });
}

function outranks(
  actionable: boolean,
  order: number,
  bestActionable: boolean,
  bestOrder: number,
): boolean {
  if (actionable !== bestActionable) return actionable;
  return order > bestOrder;
}
