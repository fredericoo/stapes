import {
  absoluteElevation,
  baseCellWorldOrigin,
  drawOrder,
  screenToCoord,
  spriteWorldOrigin,
} from "../lib/geometry";
import { coveredBySomething } from "../game/affordances";
import type { ObjectRef } from "../game/GameSession";
import { isBattler } from "../lib/battler";
import { resolveDialog } from "../lib/dialog";
import { isInteractive } from "../lib/interactions";
import { type RoofCut, cutHides } from "../lib/levelVisibility";
import { isSpanPart, spanAnchor } from "../lib/footprint";
import { elevationAt, getStack } from "../lib/mapData";
import { getFrames } from "../lib/tileResolve";
import type { MapFile, PlacedTile, StateSprites, TileDef, TileSprite } from "../lib/types";
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
 * `foot` tests the foot square of each level's cell under the pointer; `sprite`
 * tests the idle art's bounds of every tile near it. Callers ask `sprite` only
 * once `foot` found nothing, so tall art never takes a click from a tile whose
 * own cell is under the pointer.
 */
export type Reach = "foot" | "sprite";

type PickOpts = {
  centerZ: number;
  levelSlack: number;
  reach: Reach;
  cut?: RoofCut;
  accepts?: (def: TileDef) => boolean;
  isActionable?: (ref: ObjectRef) => boolean;
};

function pickTopAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  opts: PickOpts,
): ObjectRef | null {
  const zMax = Math.min(MAX_LEVEL, opts.centerZ + opts.levelSlack);
  const zMin = Math.max(MIN_LEVEL, opts.centerZ - opts.levelSlack);
  const world = {
    x: screenX / ctx.zoom + ctx.camera.x,
    y: screenY / ctx.zoom + ctx.camera.y,
  };
  const around = opts.reach === "sprite" ? spriteReach(ctx.tilesById) : NO_REACH;

  let best: ObjectRef | null = null;
  let bestActionable = false;
  let bestOrder = -Infinity;

  for (let z = zMin; z <= zMax; z++) {
    const under = screenToCoord(screenX, screenY, ctx.zoom, ctx.camera.x, ctx.camera.y, z);

    for (let y = under.y - around.down; y <= under.y + around.up; y++) {
      for (let x = under.x - around.right; x <= under.x + around.left; x++) {
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
        const elevation = elevationAt(stack, stackIndex, ctx.tilesById);
        if (
          opts.reach === "sprite" &&
          !spriteCovers(ctx, { x, y, z, elevation }, stack[stackIndex]!, world)
        ) {
          continue;
        }
        const ref: ObjectRef | null = spanAnchor(ctx.map, { x, y, z, stackIndex });
        if (!ref) continue;
        const order = drawOrder(x, y, absoluteElevation(z, elevation), stackIndex);
        if (best && !outranks(actionable, order, bestActionable, bestOrder)) {
          continue;
        }

        best = ref;
        bestActionable = actionable;
        bestOrder = order;
      }
    }
  }

  return best;
}

function spriteCovers(
  ctx: PickContext,
  cell: { x: number; y: number; z: number; elevation: number },
  placed: PlacedTile,
  world: { x: number; y: number },
): boolean {
  if (isSpanPart(placed)) return false;
  const def = ctx.tilesById[placed.tileId];
  if (!def) return false;
  const frame = getFrames(def, {
    direction: placed.direction,
    variant: placed.variant,
    map: ctx.map,
    x: cell.x,
    y: cell.y,
    z: cell.z,
  })?.[0];
  if (!frame) return false;
  const origin = spriteWorldOrigin(
    baseCellWorldOrigin(cell.x, cell.y, cell.z, cell.elevation),
    frame.sprite.base,
  );
  return (
    world.x >= origin.x &&
    world.x < origin.x + frame.sprite.rect.w * CELL_SIZE &&
    world.y >= origin.y &&
    world.y < origin.y + frame.sprite.rect.h * CELL_SIZE
  );
}

type SpriteReach = { left: number; right: number; up: number; down: number };

const NO_REACH: SpriteReach = { left: 0, right: 0, up: 0, down: 0 };

/**
 * Elevation draws a tile up and left of its foot by one cell per
 * `HEIGHT_PER_LEVEL` of stack beneath it, so feet that far right of and below
 * the pointer are searched too; two cells covers a stack eight units tall.
 */
const ELEVATION_REACH_CELLS = 2;

const reachByCatalogue = new WeakMap<Record<string, TileDef>, SpriteReach>();

/**
 * How many cells away from the pointer a foot can be and still have its art
 * cover the pointer, in each direction, over every idle sprite in the catalogue.
 * `left` is how far art reaches left of its foot, so it bounds feet to the
 * pointer's right.
 */
function spriteReach(tilesById: Record<string, TileDef>): SpriteReach {
  const cached = reachByCatalogue.get(tilesById);
  if (cached) return cached;
  const reach = { left: ELEVATION_REACH_CELLS, right: 0, up: ELEVATION_REACH_CELLS, down: 0 };
  for (const def of Object.values(tilesById)) {
    for (const sprite of idleSprites(def)) {
      for (const { sprite: ref } of sprite.frames) {
        reach.left = Math.max(reach.left, ref.base.x + ELEVATION_REACH_CELLS);
        reach.right = Math.max(reach.right, ref.rect.w - 1 - ref.base.x);
        reach.up = Math.max(reach.up, ref.base.y + ELEVATION_REACH_CELLS);
        reach.down = Math.max(reach.down, ref.rect.h - 1 - ref.base.y);
      }
    }
  }
  reachByCatalogue.set(tilesById, reach);
  return reach;
}

function idleSprites(holder: StateSprites): TileSprite[] {
  return [
    ...(holder.sprite ? [holder.sprite] : []),
    ...Object.values(holder.sprites ?? {}),
    ...Object.values(holder.slices ?? {}),
    ...Object.values(holder.variants ?? {}),
    ...(holder.scatter ?? []),
  ].filter((sprite): sprite is TileSprite => sprite !== undefined);
}

export function pickInteractiveAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
  reach: Reach,
  isActionable: (ref: ObjectRef) => boolean = () => false,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    reach,
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
  reach: Reach,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    reach,
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
  const opts = { centerZ, levelSlack, cut };
  return (
    pickTopAt(ctx, screenX, screenY, { ...opts, reach: "foot" }) ??
    pickTopAt(ctx, screenX, screenY, { ...opts, reach: "sprite" })
  );
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
