import {
  absoluteElevation,
  baseCellWorldOrigin,
  drawOrder,
  screenToCoord,
} from "../lib/geometry";
import type { ObjectRef } from "../game/GameSession";
import { isBattler } from "../lib/battler";
import { isInteractive } from "../lib/interactions";
import { elevationAt, getStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { CELL_SIZE, MAX_LEVEL, MIN_LEVEL } from "../lib/types";

/**
 * Picking is by the tile's **foot** — the one cell it stands on — and never by
 * the art hanging off it.
 *
 * Testing the drawn sprite sounds more honest and is unusable. Art is authored
 * up and to the left of the cell it belongs to, so a four-cell tree covers the
 * ground of everything behind it: the tree is trivial to hit from anywhere in a
 * wide region it does not occupy, and the cat standing one cell back is
 * *unreachable*, because the tree's quad wins the depth comparison over every
 * pixel of it. Size became reach, and small things behind big things could not
 * be pointed at at all.
 *
 * A foot is the same eight pixels square for every tile — the ground its column
 * stands on, which is where a player already believes the thing is: you point at
 * its base, not at its canopy. Squares that size tile the plane, so each level
 * offers exactly one candidate cell and picking needs no search at all. It also
 * makes the pick independent of the texture atlas, so nothing here waits on
 * assets to load.
 *
 * The cost is deliberate and worth naming: the top of a tall sprite is not
 * clickable. Pointing at a tree's leaves selects whatever is standing on the
 * ground there — which is the same rule the world already uses for depth, and
 * the only rule under which everything on screen is reachable.
 */

/**
 * The eight-pixel square a cell's whole column stands on, in world pixels.
 *
 * At elevation zero, always — the ground, not the raised top of whatever is
 * stacked there. That is what makes these squares *tile the plane*: every point
 * on a level belongs to exactly one of them, so there is no gap for a pointer to
 * fall into and no cell that is bigger to aim at than any other.
 *
 * Measuring at each tile's own elevation instead is the obvious thing and it
 * leaves holes. A tile standing one unit up has its square lifted four pixels
 * up-left, off the strip of ground it used to cover — and nothing else claims
 * that strip, because the tile that would have is the one that moved. On screen
 * that was a half-cell band, below and right of anything raised, where pointing
 * selected nothing at all.
 */
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
  /** Top-left of the view in world pixels. */
  camera: { x: number; y: number };
  zoom: number;
};

/**
 * What the pointer is over, from the one cell per level it can possibly be.
 *
 * Ground squares tile the plane and {@link screenToCoord} is their exact
 * inverse, so a point belongs to exactly one cell on each level and there is
 * nothing to search: three levels are three lookups. This replaced a pair of
 * indexes that were rebuilt whenever the map changed identity — every commit
 * anywhere in the world — and each rebuild walked every cell on three levels to
 * find the dozen that were interesting. It cost 17ms a frame on the live map to
 * produce 23 candidates, and only ever ran while the cursor was over the canvas,
 * which is how it presented: fps that recovered the moment the mouse left.
 *
 * Only the top of each stack is a candidate. A buried tile is not on screen,
 * and you can neither look at nor click what you cannot see.
 *
 * Candidates are ranked by `isActionable` first and draw order second. Draw
 * order alone loses the object the player came for whenever something inert
 * overlaps it — a doorway two cells off is drawn in front of the crate beside
 * you, and it has no business swallowing the click when tapping it would do
 * nothing. Reaching past it costs nothing, because the thing in front is not
 * a target at all right now.
 *
 * Feet on different levels do overlap on screen — a floor above projects onto
 * the one below — which is why the draw-order tie-break survives the move away
 * from sprite quads.
 */
function pickTopAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  opts: {
    centerZ: number;
    levelSlack: number;
    /** Highest level to consider. @see pickTileAt */
    ceiling?: number;
    /** Which tiles are candidates at all. Every tile, when absent. */
    accepts?: (def: TileDef) => boolean;
    isActionable?: (ref: ObjectRef) => boolean;
  },
): ObjectRef | null {
  const zMax = Math.min(
    MAX_LEVEL,
    opts.centerZ + opts.levelSlack,
    opts.ceiling ?? MAX_LEVEL,
  );
  const zMin = Math.max(MIN_LEVEL, opts.centerZ - opts.levelSlack);

  let best: ObjectRef | null = null;
  let bestActionable = false;
  let bestOrder = -Infinity;

  for (let z = zMin; z <= zMax; z++) {
    // Exactly the cell whose ground square holds this point — the inverse of
    // {@link footRect}, which is why no search is needed around it.
    const { x, y } = screenToCoord(
      screenX,
      screenY,
      ctx.zoom,
      ctx.camera.x,
      ctx.camera.y,
      z,
    );

    const stack = getStack(ctx.map, x, y, z);
    const stackIndex = stack.length - 1;
    const placed = stack[stackIndex];
    if (!placed) continue;
    const def = ctx.tilesById[placed.tileId];
    if (!def) continue;
    if (opts.accepts && !opts.accepts(def)) continue;

    const ref: ObjectRef = { x, y, z, stackIndex };
    const actionable = opts.isActionable?.(ref) ?? false;
    // Elevation of the *top* tile: everything under it, stacked. Only the sort
    // key reads it — where the tile is *hit* is the ground, not its own height.
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

/** The interactive object under a canvas-relative point. @see pickTopAt */
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

/** The body with hit points under a canvas-relative point. @see pickTopAt */
export function pickBattlerAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    accepts: isBattler,
  });
}

/**
 * The tile whose column is under a canvas-relative point — the pick behind
 * *looking*.
 *
 * Every tile is a candidate, because looking names whatever is there rather
 * than whatever can be done to it. `hideLevelsAbove` is honoured for the reason
 * only the top of a stack is offered: a roof the view has cut away is not there
 * to be named. A roof that is still drawn very much is, and reports "Roof".
 *
 * This used to probe a square of cells around the pointer, sized by the widest
 * sprite in the tile set, and test each one's art. Both the search and the
 * dependency on the atlas are gone with it.
 */
export function pickTileAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
  hideLevelsAbove?: number,
): ObjectRef | null {
  return pickTopAt(ctx, screenX, screenY, {
    centerZ,
    levelSlack,
    ceiling: hideLevelsAbove,
  });
}

/** Lexicographic rank: actionable beats inert, then frontmost beats behind. */
function outranks(
  actionable: boolean,
  order: number,
  bestActionable: boolean,
  bestOrder: number,
): boolean {
  if (actionable !== bestActionable) return actionable;
  return order > bestOrder;
}
