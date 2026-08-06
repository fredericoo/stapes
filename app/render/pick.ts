import { absoluteElevation, drawOrder } from "../lib/geometry";
import type { ObjectRef } from "../game/GameSession";
import { isInteractive } from "../lib/interactions";
import { getStack, listCoords } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
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
        elevation += def?.height ?? 0;
        // Buried under another tile: not hoverable, not draggable.
        if (stackIndex !== stack.length - 1) return;
        if (!def || !isInteractive(def)) return;
        out.push({ ref: { x, y, z, stackIndex }, elevation: drawnAt });
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
 * A rect test against each candidate's sprite quad, taking the frontmost hit.
 * There is no ID buffer and no readback: the candidate list is only the
 * interactive placements on one level, so brute force is cheaper than a pass.
 */
export function pickInteractiveAt(
  ctx: PickContext,
  index: InteractiveIndex,
  screenX: number,
  screenY: number,
): ObjectRef | null {
  const worldX = ctx.camera.x + screenX / ctx.zoom;
  const worldY = ctx.camera.y + screenY / ctx.zoom;

  let best: ObjectRef | null = null;
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

    const order = drawOrder(
      ref.x,
      ref.y,
      absoluteElevation(ref.z, elevation),
      ref.stackIndex,
    );
    if (order <= bestOrder) continue;
    bestOrder = order;
    best = ref;
  }

  return best;
}
