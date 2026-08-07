import { surfaceTileAt } from "../lib/mapData";
import type { PushInteraction } from "../lib/interactions";
import { CLIMB_HEIGHT_UNITS } from "../lib/interactions";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { fitsAtElevation } from "../lib/validation";
import { findLandingAbs } from "./gravity";
import { DIR_DELTA, listStandingSurfaces, standingAbs } from "./movement";

export type PushCheck = { ok: true; to: Coord } | { ok: false; reason: string };

/** A pushable object's place in the map — cell plus slot in its stack. */
export type PushFrom = Coord & { stackIndex: number };

/**
 * Does the surface at `abs` satisfy the tile's move-on-tiles restriction?
 * An empty list means anywhere.
 */
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

/**
 * Lowest surface in `[lo, hi]` the object can actually occupy, if any.
 *
 * Lowest, not highest: a shove has no aim, so when the cell ahead offers both
 * a step up and a step down the object takes the one gravity would.
 */
function surfaceToRestOn(
  map: MapFile,
  x: number,
  y: number,
  lo: number,
  hi: number,
  def: TileDef,
  push: PushInteraction,
  tilesById: Record<string, TileDef>,
): Coord | null {
  const candidates = listStandingSurfaces(map, x, y, tilesById)
    .filter((s) => s.abs >= lo && s.abs <= hi)
    .sort((a, b) => a.abs - b.abs);

  for (const surface of candidates) {
    if (!fitsAtElevation(map, x, y, surface.abs, def, tilesById).ok) continue;
    if (!surfaceAllowed(map, x, y, surface.abs, push, tilesById)) continue;
    return { x, y, z: surface.z };
  }
  return null;
}

/**
 * Where an object with gravity ends up after being shoved into open air above
 * (x,y). Uses the same solid-stop search the player falls with, so a crate
 * cannot tunnel through a surface it merely fails to fit on.
 */
function landingBelow(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  def: TileDef,
  push: PushInteraction,
  tilesById: Record<string, TileDef>,
): PushCheck {
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

  if (!surfaceAllowed(map, x, y, landingAbs, push, tilesById)) {
    return { ok: false, reason: "Landing tile is not in the move-on list" };
  }

  return { ok: true, to: { x, y, z: surface.z } };
}

/**
 * Where an object lands when shoved one cell in `direction`.
 *
 * Mirrors {@link canWalk}: the object steps onto any walkable surface within
 * its climb band, and when nothing is in reach it enters the cell in open air
 * and physics settles it — objects with `affectedByGravity` fall to whatever
 * is below, objects without it have nowhere to go and the push fails. That is
 * why there is no separate "allow drop" switch.
 *
 * Unlike walking, `climbFrom` is not consulted: a ramp's climb sides describe
 * how a walker may mount it, and the tile's own `climb` is the authored
 * control for pushed objects.
 */
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

  const fromAbs = standingAbs(
    map,
    from.x,
    from.y,
    from.z,
    from.stackIndex,
    tilesById,
  );
  const maxClimb = CLIMB_HEIGHT_UNITS[push.climb];

  const stepped = surfaceToRestOn(
    map,
    destX,
    destY,
    fromAbs - maxClimb,
    fromAbs + maxClimb,
    def,
    push,
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

  return landingBelow(map, destX, destY, fromAbs, def, push, tilesById);
}
