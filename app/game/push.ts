import { elevationAt, getStack, stackHeight, surfaceTileAt } from "../lib/mapData";
import type { PushInteraction } from "../lib/interactions";
import { CLIMB_HEIGHT_UNITS } from "../lib/interactions";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, physicalHeight } from "../lib/types";
import { fitsHeightAtElevation } from "../lib/validation";
import { FALL_MS_PER_HEIGHT, MAX_CLIMB_HEIGHT, PUSH_STEP_MS } from "./constants";
import { DIR_DELTA, findLandingAbs, listStandingSurfaces } from "./movement";

export type PushCheck = { ok: true; to: Coord } | { ok: false; reason: string };

export type PushFrom = Coord & { stackIndex: number };

export function pushedColumn(map: MapFile, from: PushFrom): PlacedTile[] {
  return getStack(map, from.x, from.y, from.z).slice(from.stackIndex);
}

function pushedFeetAbs(map: MapFile, from: PushFrom, tilesById: Record<string, TileDef>): number {
  const stack = getStack(map, from.x, from.y, from.z);
  return from.z * HEIGHT_PER_LEVEL + elevationAt(stack, from.stackIndex, tilesById);
}

function pushedHeight(column: readonly PlacedTile[], tilesById: Record<string, TileDef>): number {
  let total = 0;
  for (const placed of column) {
    const def = tilesById[placed.tileId];
    if (def) total += physicalHeight(def);
  }
  return total;
}

function surfaceAllowed(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  push: PushInteraction,
  tilesById: Record<string, TileDef>,
): boolean {
  if (push.moveOnTileIds.length === 0) return true;
  const placed = surfaceTileAt(map, x, y, abs, tilesById);
  return placed != null && push.moveOnTileIds.includes(placed.tileId);
}

function surfaceToRestOn(
  map: MapFile,
  x: number,
  y: number,
  lo: number,
  hi: number,
  height: number,
  push: PushInteraction,
  tilesById: Record<string, TileDef>,
): Coord | null {
  const candidates = listStandingSurfaces(map, x, y, tilesById)
    .filter((s) => s.abs >= lo && s.abs <= hi)
    .sort((a, b) => a.abs - b.abs);

  for (const surface of candidates) {
    if (!fitsHeightAtElevation(map, x, y, surface.abs, height, tilesById).ok) {
      continue;
    }
    if (!surfaceAllowed(map, x, y, surface.abs, push, tilesById)) continue;
    return { x, y, z: surface.z };
  }
  return null;
}

function landingBelow(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  height: number,
  push: PushInteraction,
  tilesById: Record<string, TileDef>,
): PushCheck {
  /**
   * `findLandingAbs` counts only tops strictly below the feet it is given. A
   * floor level with the shoved feet is what the column would rest on, so it
   * has to answer here; searching from `fromAbs` alone skipped it, and a push
   * refused by that floor dropped through it to the level below.
   */
  const landingAbs = findLandingAbs(map, x, y, fromAbs + 1, tilesById);
  if (landingAbs == null) {
    return { ok: false, reason: "Nothing below to land on" };
  }

  const surface = listStandingSurfaces(map, x, y, tilesById).find((s) => s.abs === landingAbs);
  if (!surface) {
    return { ok: false, reason: "Landing surface is not walkable" };
  }

  const fit = fitsHeightAtElevation(map, x, y, landingAbs, height, tilesById);
  if (!fit.ok) return fit;

  if (!surfaceAllowed(map, x, y, landingAbs, push, tilesById)) {
    return { ok: false, reason: "Landing tile is not in the move-on list" };
  }

  return { ok: true, to: { x, y, z: surface.z } };
}

export function pushDestination(
  map: MapFile,
  from: PushFrom,
  direction: Direction,
  def: TileDef,
  push: PushInteraction,
  tilesById: Record<string, TileDef>,
): PushCheck {
  if (pushedColumn(map, from).some((placed) => placed.span)) {
    return { ok: false, reason: "Too big to push" };
  }

  const { dx, dy } = DIR_DELTA[direction];
  const destX = from.x + dx;
  const destY = from.y + dy;

  const fromAbs = pushedFeetAbs(map, from, tilesById);
  const height = pushedHeight(pushedColumn(map, from), tilesById);
  const maxClimb = CLIMB_HEIGHT_UNITS[push.climb];

  const stepped = surfaceToRestOn(
    map,
    destX,
    destY,
    fromAbs - maxClimb,
    fromAbs + maxClimb,
    height,
    push,
    tilesById,
  );
  if (stepped) return { ok: true, to: stepped };

  const clear = fitsHeightAtElevation(map, destX, destY, fromAbs, height, tilesById);
  if (!clear.ok) return clear;

  if (!def.affectedByGravity) {
    return { ok: false, reason: "Nothing to rest on and no gravity to fall" };
  }

  return landingBelow(map, destX, destY, fromAbs, height, push, tilesById);
}

/**
 * How far a shoved column drops after it has slid across, measured on the board
 * the shove has already written. A drop a body would step down is folded into
 * the slide itself, as `gravityPullOn` folds it into a settle.
 */
export function pushDropUnits(
  map: MapFile,
  from: Coord,
  object: Coord & { stackIndex: number },
  tilesById: Record<string, TileDef>,
): number {
  const originFoot =
    from.z * HEIGHT_PER_LEVEL + stackHeight(getStack(map, from.x, from.y, from.z), tilesById);
  const landedFoot =
    object.z * HEIGHT_PER_LEVEL +
    elevationAt(getStack(map, object.x, object.y, object.z), object.stackIndex, tilesById);
  const drop = originFoot - landedFoot;
  return drop > MAX_CLIMB_HEIGHT ? drop : 0;
}

export function slideDurationMs(dropUnits: number): number {
  return PUSH_STEP_MS + dropUnits * FALL_MS_PER_HEIGHT;
}

/** The pusher is busy for the shove only; the drop that follows is the column's. */
export function slideStillShoving(elapsedMs: number): boolean {
  return elapsedMs < PUSH_STEP_MS;
}

export type SlidePhases = { across: number; down: number };

/**
 * Splits a slide's progress into the shove across and the fall after it, each
 * 0..1. With no drop both run together, which is the straight line a step up
 * or down a half-height ledge has always been drawn as.
 */
export function slidePhases(dropUnits: number, progress: number): SlidePhases {
  if (dropUnits === 0) return { across: progress, down: progress };
  const elapsedMs = progress * slideDurationMs(dropUnits);
  const fallMs = dropUnits * FALL_MS_PER_HEIGHT;
  return {
    across: Math.min(1, elapsedMs / PUSH_STEP_MS),
    down: Math.min(1, Math.max(0, (elapsedMs - PUSH_STEP_MS) / fallMs)),
  };
}
