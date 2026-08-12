import { absoluteElevation, drawOrder, screenToCoord } from "../lib/geometry";
import type { ObjectRef } from "../game/GameSession";
import { isBattler } from "../lib/battler";
import { isInteractive } from "../lib/interactions";
import { getStack, listCoords, stackHeight } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  allTileSprites,
  physicalHeight,
} from "../lib/types";
import {
  type SpriteQuadAssets,
  quadContains,
  spriteQuadFor,
} from "./spriteQuad";

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
  assets: SpriteQuadAssets;
  /** Top-left of the view in world pixels. */
  camera: { x: number; y: number };
  zoom: number;
};

/**
 * The interactive object drawn under a canvas-relative point, or null.
 *
 * A rect test against each candidate's sprite quad. There is no ID buffer and
 * no readback: the candidate list is only the interactive placements on one
 * level, so brute force is cheaper than a pass.
 *
 * Candidates are ranked by `isActionable` first and draw order second. Draw
 * order alone loses the object the player came for whenever something inert
 * overlaps it — a doorway two cells off is drawn in front of the crate beside
 * you, and it has no business swallowing the click when tapping it would do
 * nothing. Reaching past it costs nothing, because the thing in front is not
 * a target at all right now.
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

    const quad = spriteQuadFor(
      ctx.assets,
      ctx.map,
      { x: ref.x, y: ref.y, z: ref.z, elevation },
      placed,
      def,
    );
    if (!quad || !quadContains(quad, worldX, worldY)) continue;

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
 * How far a sprite can reach past the cell the pointer is over, in cells.
 *
 * Two things move art away from its own footprint, and the probe has to cover
 * both. A multi-cell sprite hangs up and left of its base cell by up to its own
 * rect. Elevation shifts a tile up-left by {@link PX_PER_HEIGHT} per height
 * unit, and a stack may overflow one level into the next — four height units,
 * or two cells.
 *
 * Derived from the tile set rather than declared, so a taller or wider sprite
 * cannot silently stop being pickable. Cheap, but call it once per tile set:
 * this is not per-pointer-move work.
 */
export function probeSpanFor(tilesById: Record<string, TileDef>): number {
  let maxRect = 1;
  for (const def of Object.values(tilesById)) {
    for (const sprite of allTileSprites(def)) {
      for (const frame of sprite.frames) {
        const { w, h } = frame.sprite.rect;
        if (w > maxRect) maxRect = w;
        if (h > maxRect) maxRect = h;
      }
    }
  }
  return maxRect;
}

/** Height units a stack can reach before the level above takes over. */
const MAX_OVERFLOW_CELLS = 2;

/**
 * The tile drawn under a canvas-relative point, whatever it is — the pick
 * behind *looking*.
 *
 * Deliberately not an index. {@link indexInteractive} is affordable because
 * interactive placements are rare; every top-of-stack tile on three levels is
 * thousands of entries, needing a `spriteQuadFor` each per pointer move and a
 * rebuild on every map identity — which during a walk is every commit. So the
 * *probe* is bounded instead: invert the projection to the cell under the
 * pointer and test the handful of cells whose art could reach it. Nothing is
 * cached, so nothing can go stale.
 *
 * Only the top of each stack is a candidate, for the same reason it is in the
 * interactive index: a buried tile is not on screen, and you cannot look at
 * what you cannot see. `hideLevelsAbove` is honoured for that same reason —
 * a roof the view has cut away is not there to be named. A roof that is still
 * drawn very much is, and reports "Roof".
 */
export function pickTileAt(
  ctx: PickContext,
  span: number,
  screenX: number,
  screenY: number,
  centerZ: number,
  levelSlack: number,
  hideLevelsAbove?: number,
): ObjectRef | null {
  const worldX = ctx.camera.x + screenX / ctx.zoom;
  const worldY = ctx.camera.y + screenY / ctx.zoom;

  const zMax = Math.min(
    MAX_LEVEL,
    centerZ + levelSlack,
    hideLevelsAbove ?? MAX_LEVEL,
  );
  const zMin = Math.max(MIN_LEVEL, centerZ - levelSlack);

  // A sprite reaches *toward* the camera from its base cell, so the cells that
  // can cover a point lie down-right of it — hence the asymmetry.
  const behind = span;
  const ahead = span + MAX_OVERFLOW_CELLS;

  let best: ObjectRef | null = null;
  let bestOrder = -Infinity;

  for (let z = zMin; z <= zMax; z++) {
    const base = screenToCoord(
      screenX,
      screenY,
      ctx.zoom,
      ctx.camera.x,
      ctx.camera.y,
      z,
    );

    for (let dy = -behind; dy <= ahead; dy++) {
      for (let dx = -behind; dx <= ahead; dx++) {
        const x = base.x + dx;
        const y = base.y + dy;
        const stack = getStack(ctx.map, x, y, z);
        if (stack.length === 0) continue;

        const placed = stack[stack.length - 1]!;
        const def = ctx.tilesById[placed.tileId];
        if (!def) continue;

        // Elevation of the *top* tile: everything under it, stacked.
        let elevation = 0;
        for (let i = 0; i < stack.length - 1; i++) {
          const under = ctx.tilesById[stack[i]!.tileId];
          if (under) elevation += physicalHeight(under);
        }

        const quad = spriteQuadFor(
          ctx.assets,
          ctx.map,
          { x, y, z, elevation },
          placed,
          def,
        );
        if (!quad || !quadContains(quad, worldX, worldY)) continue;

        const stackIndex = stack.length - 1;
        const order = drawOrder(
          x,
          y,
          absoluteElevation(z, elevation),
          stackIndex,
        );
        if (order <= bestOrder) continue;

        best = { x, y, z, stackIndex };
        bestOrder = order;
      }
    }
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
