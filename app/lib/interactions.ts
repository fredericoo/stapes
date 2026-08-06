import * as v from "valibot";
import type { TileDef } from "./types";
import { HEIGHT_PER_LEVEL } from "./types";

/**
 * How far up a dragged object can step. Descent is deliberately absent —
 * going down is physics: any step down is legal, and whether the object then
 * falls is already answered by {@link TileDef.affectedByGravity}.
 */
export type ClimbAbility = "none" | "half" | "full";

export const CLIMB_ABILITIES: ClimbAbility[] = ["none", "half", "full"];

/** Max upward step in absolute height units, per ability. */
export const CLIMB_HEIGHT_UNITS: Record<ClimbAbility, number> = {
  none: 0,
  half: HEIGHT_PER_LEVEL / 2,
  full: HEIGHT_PER_LEVEL,
};

export type DragInteraction = {
  /**
   * Ground-distance budget for one drag gesture (fractional). Orthogonal steps
   * cost 1; diagonals cost √2 — so 1.5 reaches any adjacent cell, while 1 is
   * orthogonal only. Resets each drag.
   */
  distanceTiles: number;
  /** Max upward step. Descent is unconstrained — gravity resolves it. */
  climb: ClimbAbility;
  /** When non-empty, the object may only come to rest on these tile ids. */
  moveOnTileIds: string[];
};

/** Ways the player can interact with a placed object. Grows over time. */
export type TileInteractions = {
  drag?: DragInteraction;
};

export const MAX_DRAG_DISTANCE_TILES = 32;

export const DEFAULT_DRAG: DragInteraction = {
  distanceTiles: 1,
  climb: "half",
  moveOnTileIds: [],
};

const dragSchema = v.object({
  distanceTiles: v.pipe(
    v.number(),
    v.minValue(1),
    v.maxValue(MAX_DRAG_DISTANCE_TILES),
  ),
  climb: v.picklist(CLIMB_ABILITIES),
  moveOnTileIds: v.array(v.string()),
});

/**
 * Parsed drag config per tile def. `data/tiles.json` is hand-editable, so the
 * shape is validated rather than trusted; a malformed block reads as "not
 * draggable" instead of throwing mid-frame.
 *
 * Memoised on def identity — {@link isInteractive} runs over every candidate
 * tile on each pointer move.
 */
const dragCache = new WeakMap<TileDef, DragInteraction | null>();

export function resolveDrag(def: TileDef): DragInteraction | null {
  const cached = dragCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.drag;
  const parsed = raw == null ? null : v.safeParse(dragSchema, raw);
  const drag = parsed?.success ? parsed.output : null;
  dragCache.set(def, drag);
  return drag;
}

/** Kinds of interaction a tile offers. Grows as new interactions are added. */
export type InteractionKind = "drag";

/** Every interaction enabled on this tile, in a stable order. */
export function interactionKinds(def: TileDef): InteractionKind[] {
  const kinds: InteractionKind[] = [];
  if (resolveDrag(def)) kinds.push("drag");
  return kinds;
}

/** Whether the player can do anything at all with this tile. */
export function isInteractive(def: TileDef): boolean {
  return interactionKinds(def).length > 0;
}

/** Persist interactions; omit the field entirely when nothing is enabled. */
export function interactionsForSave(
  interactions: TileInteractions | undefined,
): TileInteractions | undefined {
  const drag = interactions?.drag;
  if (!drag) return undefined;
  return {
    drag: {
      distanceTiles: drag.distanceTiles,
      climb: drag.climb,
      moveOnTileIds: [...drag.moveOnTileIds].sort(),
    },
  };
}
