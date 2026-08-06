import { getStack, surfaceTileAt } from "../lib/mapData";
import type { DragInteraction } from "../lib/interactions";
import { CLIMB_HEIGHT_UNITS } from "../lib/interactions";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { coordKey } from "../lib/types";
import { fitsAtElevation } from "../lib/validation";
import { findLandingAbs } from "./gravity";
import { listStandingSurfaces, standingAbs } from "./movement";

export type DragStepCheck =
  | { ok: true; to: Coord }
  | { ok: false; reason: string };

/**
 * A diagonal covers √2 tiles of ground, so a budget of 1.5 buys exactly one
 * step in any of the eight directions while two orthogonal steps (2.0) stay
 * out of reach. Distances are therefore fractional, not step counts.
 */
export const DIAGONAL_STEP_COST = Math.SQRT2;

/** One of the eight ways a dragged object can step, and what it costs. */
export type DragStep = { dx: number; dy: number; cost: number };

export type DragStepName =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

export const DRAG_STEP_BY_NAME: Record<DragStepName, DragStep> = {
  n: { dx: 0, dy: -1, cost: 1 },
  e: { dx: 1, dy: 0, cost: 1 },
  s: { dx: 0, dy: 1, cost: 1 },
  w: { dx: -1, dy: 0, cost: 1 },
  ne: { dx: 1, dy: -1, cost: DIAGONAL_STEP_COST },
  se: { dx: 1, dy: 1, cost: DIAGONAL_STEP_COST },
  sw: { dx: -1, dy: 1, cost: DIAGONAL_STEP_COST },
  nw: { dx: -1, dy: -1, cost: DIAGONAL_STEP_COST },
};

export const DRAG_STEPS: DragStep[] = Object.values(DRAG_STEP_BY_NAME);

/** Slack for comparing accumulated float costs against the budget. */
const COST_EPSILON = 1e-9;

export type DragTarget = {
  /** Cell the object comes to rest in. */
  to: Coord;
  /** Cells stepped through to get there, excluding the start, ending at `to`. */
  path: Coord[];
};

/** Reachable destinations, keyed by `coordKey` of the target cell. */
export type DragTargets = Map<string, DragTarget>;

/** An object's position mid-drag; `stackIndex` may point past the stack end. */
type DragFrom = Coord & { stackIndex: number };

/**
 * Does the surface at `abs` satisfy the tile's move-on-tiles restriction?
 * An empty list means anywhere.
 */
function surfaceAllowed(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  drag: DragInteraction,
  tilesById: Record<string, TileDef>,
): boolean {
  if (drag.moveOnTileIds.length === 0) return true;
  const placed = surfaceTileAt(map, x, y, abs, tilesById);
  return placed != null && drag.moveOnTileIds.includes(placed.tileId);
}

/** Highest surface in `[lo, hi]` the object can actually occupy, if any. */
function surfaceToRestOn(
  map: MapFile,
  x: number,
  y: number,
  lo: number,
  hi: number,
  def: TileDef,
  drag: DragInteraction,
  tilesById: Record<string, TileDef>,
): Coord | null {
  const candidates = listStandingSurfaces(map, x, y, tilesById)
    .filter((s) => s.abs >= lo && s.abs <= hi)
    .sort((a, b) => b.abs - a.abs);

  for (const surface of candidates) {
    if (!fitsAtElevation(map, x, y, surface.abs, def, tilesById).ok) continue;
    if (!surfaceAllowed(map, x, y, surface.abs, drag, tilesById)) continue;
    return { x, y, z: surface.z };
  }
  return null;
}

/**
 * Where an object with gravity ends up after being pushed into open air above
 * (x,y). Uses the same solid-stop search the player falls with, so a crate
 * cannot tunnel through a surface it merely fails to fit on.
 */
function landingBelow(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  def: TileDef,
  drag: DragInteraction,
  tilesById: Record<string, TileDef>,
): DragStepCheck {
  const landingAbs = findLandingAbs(map, x, y, fromAbs, tilesById);
  if (landingAbs == null) {
    return { ok: false, reason: "Nothing below to land on" };
  }

  const surface = listStandingSurfaces(map, x, y, tilesById).find(
    (s) => s.abs === landingAbs,
  );
  if (!surface) {
    return { ok: false, reason: "Landing surface is not walkable" };
  }

  const fit = fitsAtElevation(map, x, y, landingAbs, def, tilesById);
  if (!fit.ok) return fit;

  if (!surfaceAllowed(map, x, y, landingAbs, drag, tilesById)) {
    return { ok: false, reason: "Landing tile is not in the move-on list" };
  }

  return { ok: true, to: { x, y, z: surface.z } };
}

/**
 * One step of a dragged object (orthogonal or diagonal).
 *
 * Mirrors {@link canWalk}: the object steps onto any walkable surface within
 * its climb band, and when nothing is in reach it enters the cell in open air
 * and physics settles it — objects with `affectedByGravity` fall to whatever
 * is below, objects without it stay at the elevation they were dragged to.
 * That is why there is no separate "allow drop" switch.
 *
 * Unlike walking, `climbFrom` is not consulted: a ramp's climb sides describe
 * how a walker may mount it, and the tile's own `climb` is the authored
 * control for dragged objects.
 */
export function canDragStep(
  map: MapFile,
  from: DragFrom,
  step: DragStepName,
  def: TileDef,
  drag: DragInteraction,
  tilesById: Record<string, TileDef>,
): DragStepCheck {
  const { dx, dy } = DRAG_STEP_BY_NAME[step];
  const destX = from.x + dx;
  const destY = from.y + dy;

  const fromAbs = standingAbs(
    map,
    from.x,
    from.y,
    from.z,
    from.stackIndex,
    tilesById,
  );
  const maxClimb = CLIMB_HEIGHT_UNITS[drag.climb];

  const stepped = surfaceToRestOn(
    map,
    destX,
    destY,
    fromAbs - maxClimb,
    fromAbs + maxClimb,
    def,
    drag,
    tilesById,
  );
  if (stepped) return { ok: true, to: stepped };

  // No surface in reach — enter the cell in open air, if the volume is clear.
  const clear = fitsAtElevation(map, destX, destY, fromAbs, def, tilesById);
  if (!clear.ok) return clear;

  // Without gravity there is nothing to bring it down and no way to represent
  // it hanging mid-column, so open air is simply out of reach.
  if (!def.affectedByGravity) {
    return { ok: false, reason: "Nothing to rest on and no gravity to fall" };
  }

  return landingBelow(map, destX, destY, fromAbs, def, drag, tilesById);
}

/**
 * Every cell the object can be dragged to in one gesture, cheapest-first over
 * legal steps whose accumulated ground cost stays within `drag.distanceTiles`.
 * Keyed by `coordKey` on the plan view — a cell is reachable at one resting
 * place at most, so the pointer only ever has to look up an (x,y).
 */
export function reachableDragTargets(
  map: MapFile,
  from: DragFrom,
  def: TileDef,
  drag: DragInteraction,
  tilesById: Record<string, TileDef>,
): DragTargets {
  const targets: DragTargets = new Map();
  const bestCost = new Map<string, number>([[coordKey(from.x, from.y), 0]]);
  const queue: Array<{ at: DragFrom; path: Coord[]; cost: number }> = [
    { at: from, path: [], cost: 0 },
  ];

  while (queue.length > 0) {
    // Tiny grids — sort beats a heap. Cheapest first so the first path that
    // settles on a cell is the shortest ground distance.
    queue.sort((a, b) => a.cost - b.cost);
    const node = queue.shift()!;
    const settled = bestCost.get(coordKey(node.at.x, node.at.y)) ?? Infinity;
    if (node.cost > settled + COST_EPSILON) continue;

    for (const name of Object.keys(DRAG_STEP_BY_NAME) as DragStepName[]) {
      const step = DRAG_STEP_BY_NAME[name];
      const nextCost = node.cost + step.cost;
      if (nextCost > drag.distanceTiles + COST_EPSILON) continue;

      const check = canDragStep(map, node.at, name, def, drag, tilesById);
      if (!check.ok) continue;

      const key = coordKey(check.to.x, check.to.y);
      const prior = bestCost.get(key);
      if (prior != null && nextCost >= prior - COST_EPSILON) continue;
      bestCost.set(key, nextCost);

      const path = [...node.path, check.to];
      targets.set(key, { to: check.to, path });

      queue.push({
        at: { ...check.to, stackIndex: stackIndexAfterMove(map, check.to) },
        path,
        cost: nextCost,
      });
    }
  }

  return targets;
}

/**
 * Stack slot the object would occupy at `to`. The map still holds it at its
 * original cell during the drag, so this is one past the end — which makes
 * `standingAbs` measure the full destination stack, exactly the surface the
 * object would be resting on.
 */
function stackIndexAfterMove(map: MapFile, to: Coord): number {
  return getStack(map, to.x, to.y, to.z).length;
}
