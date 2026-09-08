/**
 * The parts every procedural generator is built out of.
 *
 * A generator is a pure function from a map, a rectangle, a level and a
 * settings object to the list of {@link StackEdit}s that build the thing — or
 * to the reason it cannot be built. That contract is the whole of why the drag
 * preview and the commit cannot disagree: they call the same function. See
 * `docs/notes.md`, "A generator is a plan, and the plan is the preview".
 *
 * This module holds what more than one of them needs, so that adding a second
 * generator is a plan function rather than a second copy of the rectangle.
 */

import type { StackEdit } from "../lib/mapData";
import type { Direction, PlacedTile, TileDef } from "../lib/types";
import { isDirectional } from "../lib/types";

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/** What every generator returns: the edits, or why there are none. */
export type GeneratedPlan =
  | { ok: true; edits: StackEdit[] }
  | { ok: false; reason: string };

/**
 * Both dimensions of any generator's footprint, so an accidental drag across
 * the world refuses cheaply rather than planning four thousand cells.
 */
export const MAX_FOOTPRINT = 64;

export function boundsOf(rect: Rect): Bounds {
  return {
    minX: Math.min(rect.x0, rect.x1),
    maxX: Math.max(rect.x0, rect.x1),
    minY: Math.min(rect.y0, rect.y1),
    maxY: Math.max(rect.y0, rect.y1),
  };
}

/** A placement of `tileId`, wearing `direction` only if the tile has faces. */
export function placed(
  tileId: string,
  tilesById: Record<string, TileDef>,
  direction?: Direction,
): PlacedTile {
  const def = tilesById[tileId];
  if (def && isDirectional(def)) {
    return { tileId, direction: direction ?? "s" };
  }
  return { tileId };
}
