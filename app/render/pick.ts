import {
  absoluteElevation,
  baseCellWorldOrigin,
  drawOrder,
  screenToCoord,
} from "../lib/geometry";
import type { ObjectRef } from "../game/GameSession";
import { isBattler } from "../lib/battler";
import { isInteractive } from "../lib/interactions";
import { getStack, listCoords, stackHeight } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import {
  CELL_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  physicalHeight,
} from "../lib/types";

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

function footContains(
  foot: { x: number; y: number; w: number; h: number },
  worldX: number,
  worldY: number,
): boolean {
  return (
    worldX >= foot.x &&
    worldX < foot.x + foot.w &&
    worldY >= foot.y &&
    worldY < foot.y + foot.h
  );
}

/**
 * Every interactive placement near `centerZ` that can actually be acted on —
 * only the top of its stack — with the elevation its sprite is drawn at.
 * `levelSlack` includes floors above and below (game play uses 1). Maps hold
 * far more scenery than interactive objects, so the candidate list is built
 * once per map version rather than per pointer move.
 */
export type InteractiveIndex = Array<{ ref: ObjectRef; elevation: number }>;

export function indexInteractive(
  map: MapFile,
  centerZ: number,
  tilesById: Record<string, TileDef>,
  levelSlack = 0,
): InteractiveIndex {
  const out: InteractiveIndex = [];
  const zMin = Math.max(MIN_LEVEL, centerZ - levelSlack);
  const zMax = Math.min(MAX_LEVEL, centerZ + levelSlack);

  for (let z = zMin; z <= zMax; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const stack = getStack(map, x, y, z);
      let elevation = 0;
      stack.forEach((placed, stackIndex) => {
        const def = tilesById[placed.tileId];
        const drawnAt = elevation;
        if (def) elevation += physicalHeight(def);
        // Buried under another tile: not hoverable, not interactive.
        if (stackIndex !== stack.length - 1) return;
        if (!def || !isInteractive(def)) return;
        out.push({ ref: { x, y, z, stackIndex }, elevation: drawnAt });
      });
    }
  }

  return out;
}

/**
 * Every body with hit points near `centerZ`, as pick candidates.
 *
 * The same shape and the same discipline as {@link indexInteractive}, and a
 * separate index rather than a widened one because the two questions have
 * different answers: a crate is interactive and cannot be fought, a deer is a
 * battler and cannot be shoved. Folding them together would mean every caller
 * filtering the result back down to what it actually wanted.
 *
 * Only the top of a stack counts, for the same reason it does there: a buried
 * body is not on screen, and you cannot point at what you cannot see. In
 * practice a body is always on top anyway — it is the thing standing on the
 * floor rather than under it.
 */
export function indexBattlers(
  map: MapFile,
  centerZ: number,
  tilesById: Record<string, TileDef>,
  levelSlack = 0,
): InteractiveIndex {
  const out: InteractiveIndex = [];
  const zMin = Math.max(MIN_LEVEL, centerZ - levelSlack);
  const zMax = Math.min(MAX_LEVEL, centerZ + levelSlack);

  for (let z = zMin; z <= zMax; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const stack = getStack(map, x, y, z);
      const stackIndex = stack.length - 1;
      const placed = stack[stackIndex];
      if (!placed) continue;
      const def = tilesById[placed.tileId];
      if (!def || !isBattler(def)) continue;
      out.push({
        ref: { x, y, z, stackIndex },
        elevation: stackHeight(stack.slice(0, stackIndex), tilesById),
      });
    }
  }

  return out;
}

export type PickContext = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  /** Top-left of the view in world pixels. */
  camera: { x: number; y: number };
  zoom: number;
};

/**
 * The interactive object whose foot is under a canvas-relative point, or null.
 *
 * A rect test against each candidate's foot square. There is no ID buffer and
 * no readback: the candidate list is only the interactive placements on one
 * level, so brute force is cheaper than a pass.
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
export function pickInteractiveAt(
  ctx: PickContext,
  index: InteractiveIndex,
  screenX: number,
  screenY: number,
  isActionable: (ref: ObjectRef) => boolean = () => false,
): ObjectRef | null {
  const worldX = ctx.camera.x + screenX / ctx.zoom;
  const worldY = ctx.camera.y + screenY / ctx.zoom;

  let best: ObjectRef | null = null;
  let bestActionable = false;
  let bestOrder = -Infinity;

  for (const { ref, elevation } of index) {
    const placed = getStack(ctx.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const def = placed && ctx.tilesById[placed.tileId];
    if (!placed || !def) continue;

    const foot = footRect(ref.x, ref.y, ref.z);
    if (!footContains(foot, worldX, worldY)) continue;

    const actionable = isActionable(ref);
    const order = drawOrder(
      ref.x,
      ref.y,
      absoluteElevation(ref.z, elevation),
      ref.stackIndex,
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

/**
 * The tile whose column is under a canvas-relative point — the pick behind
 * *looking*.
 *
 * Deliberately not an index. {@link indexInteractive} is affordable because
 * interactive placements are rare; every top-of-stack tile on three levels is
 * thousands of entries, rebuilt on every map identity — which during a walk is
 * every commit. So the projection is simply inverted instead: ground squares
 * tile the plane, so each level contributes exactly *one* candidate cell and
 * there is nothing to search. Nothing is cached, so nothing can go stale.
 *
 * This used to probe a square of cells around the pointer, sized by the widest
 * sprite in the tile set, and test each one's art. Both the search and the
 * dependency on the atlas are gone with it.
 *
 * Only the top of each stack is a candidate, for the same reason it is in the
 * interactive index: a buried tile is not on screen, and you cannot look at
 * what you cannot see. `hideLevelsAbove` is honoured for that same reason —
 * a roof the view has cut away is not there to be named. A roof that is still
 * drawn very much is, and reports "Roof".
 */
export function pickTileAt(
  ctx: PickContext,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
  hideLevelsAbove?: number,
): ObjectRef | null {
  const zMax = Math.min(
    MAX_LEVEL,
    centerZ + levelSlack,
    hideLevelsAbove ?? MAX_LEVEL,
  );
  const zMin = Math.max(MIN_LEVEL, centerZ - levelSlack);

  let best: ObjectRef | null = null;
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
    if (stack.length === 0) continue;

    const stackIndex = stack.length - 1;
    const placed = stack[stackIndex]!;
    if (!ctx.tilesById[placed.tileId]) continue;

    // Elevation of the *top* tile: everything under it, stacked. Only the sort
    // key reads it — where the tile is *hit* is the ground, not its own height.
    let elevation = 0;
    for (let i = 0; i < stackIndex; i++) {
      const under = ctx.tilesById[stack[i]!.tileId];
      if (under) elevation += physicalHeight(under);
    }

    const order = drawOrder(x, y, absoluteElevation(z, elevation), stackIndex);
    if (order <= bestOrder) continue;

    best = { x, y, z, stackIndex };
    bestOrder = order;
  }

  return best;
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
