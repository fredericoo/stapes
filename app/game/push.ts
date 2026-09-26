import { elevationAt, getStack, surfaceTileAt } from "../lib/mapData";
import type { PushInteraction } from "../lib/interactions";
import { CLIMB_HEIGHT_UNITS } from "../lib/interactions";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, physicalHeight } from "../lib/types";
import { fitsHeightAtElevation } from "../lib/validation";
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
  const landingAbs = findLandingAbs(map, x, y, fromAbs, tilesById);
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
