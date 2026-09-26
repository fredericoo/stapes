import {
  absoluteStandingElevation,
  chunkKeyFor,
  climbFromSourceAt,
  footingOfStack,
  getStack,
  isSolidPlacement,
  isWalkableSurfaceAt,
  planeCoveredBy,
  stackHeight,
  stackOnLevel,
  surfaceTileAt,
  walkableFloorAbove,
} from "../lib/mapData";
import { stackOcclusion } from "../lib/lighting";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, coordKey, resolveClimbFrom } from "../lib/types";
import { walkDurationFrom } from "../lib/walkSpeed";
import type { FitOpts } from "../lib/validation";
import { fitsAtElevation, fitsTile } from "../lib/validation";
import { MAX_CLIMB_HEIGHT, PLAYER_TILE_ID, WALK_DURATION_MS } from "./constants";
import { normalizeStandingCell } from "./mapMutations";

export const DIR_DELTA: Record<Direction, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};

export function sceneryStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  entityStackIndex: number,
): ReturnType<typeof getStack> {
  const stack = getStack(map, x, y, z);
  return stack.filter((_, i) => i !== entityStackIndex);
}

export function resolveWalkDurationMs(def: TileDef): number {
  const authored = def.walkDurationMs;
  return authored != null && authored > 0 ? authored : WALK_DURATION_MS;
}

export function walkDurationMsFor(def: TileDef, speedPercent: number): number {
  return walkDurationFrom(resolveWalkDurationMs(def), speedPercent);
}

export function groundWalkSpeedPercent(
  map: MapFile,
  at: Coord & { stackIndex: number },
  tilesById: Record<string, TileDef>,
): number {
  const abs = standingAbs(map, at.x, at.y, at.z, at.stackIndex, tilesById);
  const surface = surfaceTileAt(map, at.x, at.y, abs, tilesById, {
    z: at.z,
    stackIndex: at.stackIndex,
  });
  if (!surface) return 0;
  return tilesById[surface.tileId]?.walkSpeedPercent ?? 0;
}

export function wadesAt(
  map: MapFile,
  at: Coord & { stackIndex: number },
  tilesById: Record<string, TileDef>,
): boolean {
  const abs = standingAbs(map, at.x, at.y, at.z, at.stackIndex, tilesById);
  return surfaceWades(map, at.x, at.y, abs, tilesById, { z: at.z, stackIndex: at.stackIndex });
}

export function surfaceWades(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): boolean {
  const surface = surfaceTileAt(map, x, y, abs, tilesById, exclude);
  return surface != null && tilesById[surface.tileId]?.wade === true;
}

export function standingAbs(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  entityStackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  const scenery = sceneryStack(map, x, y, z, entityStackIndex);
  return absoluteStandingElevation(z, scenery, tilesById);
}

export type StandingSurface = {
  abs: number;
  z: number;
};

export function listStandingSurfaces(
  map: MapFile,
  x: number,
  y: number,
  tilesById: Record<string, TileDef>,
): StandingSurface[] {
  const out: StandingSurface[] = [];
  let closed: number[] | undefined;

  const add = (abs: number, z: number) => {
    const existing = out.find((s) => s.abs === abs);
    if (existing) {
      if (z > existing.z) existing.z = z;
      return;
    }
    out.push({ abs, z });
  };

  const chunkKey = chunkKeyFor(x, y);
  const cellKey = coordKey(x, y);
  let below: PlacedTile[] | undefined;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const stack = stackOnLevel(map, z, chunkKey, cellKey);
    if (stack !== undefined && stack.length > 0) {
      const footing = footingOfStack(stack, tilesById);
      if (planeCoveredBy(footing)) (closed ??= []).push(z * HEIGHT_PER_LEVEL);
      if (footing?.walkable) add(z * HEIGHT_PER_LEVEL + footing.elev, z);
    }
    if (below !== undefined) {
      const floorAbs = walkableFloorAbove(z - 1, below, tilesById);
      if (floorAbs != null) add(floorAbs, z);
    }
    below = stack;
  }
  if (!closed) return out;
  return out.filter((surface) => !closed.includes(surface.abs));
}

function crossesSealedPlane(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  toAbs: number,
  tilesById: Record<string, TileDef>,
): boolean {
  const lowAbs = Math.min(fromAbs, toAbs);
  const highAbs = Math.max(fromAbs, toAbs);
  const firstZ = Math.max(MIN_LEVEL, Math.floor(lowAbs / HEIGHT_PER_LEVEL) + 1);
  const lastZ = Math.min(MAX_LEVEL, Math.floor(highAbs / HEIGHT_PER_LEVEL));
  for (let z = firstZ; z <= lastZ; z++) {
    if (stackOcclusion(getStack(map, x, y, z), tilesById).sealsLevel) {
      return true;
    }
  }
  return false;
}

export type StepOrigin = { x: number; y: number; abs: number };

export function surfacesInClimbBand(
  map: MapFile,
  from: StepOrigin,
  x: number,
  y: number,
  tilesById: Record<string, TileDef>,
): StandingSurface[] {
  return listStandingSurfaces(map, x, y, tilesById).filter((surface) => {
    if (surface.abs < from.abs - MAX_CLIMB_HEIGHT) return false;
    if (surface.abs > from.abs + MAX_CLIMB_HEIGHT) return false;
    /**
     * A step up crosses the plane in the column being left; a step down
     * crosses it in the column being entered. Using the wrong column for
     * either direction lets a body climb through a ceiling, or refuses every
     * step off a ledge.
     */
    const travelColumn = surface.abs > from.abs ? from : { x, y };
    return !crossesSealedPlane(
      map,
      travelColumn.x,
      travelColumn.y,
      from.abs,
      surface.abs,
      tilesById,
    );
  });
}

export function findLandingAbs(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): number | null {
  let best: number | null = null;

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = sceneryStack(map, x, y, z, exclude.stackIndex);
    }

    /**
     * A stack with nothing solid in it is open air with decoration in it, not
     * a floor: without this guard its level base reads as a landing and a
     * body can hover in a shaft with no floor under it.
     */
    if (stack.some((placed) => isSolidPlacement(placed, tilesById))) {
      const top = absoluteStandingElevation(z, stack, tilesById);
      if (top < feetAbs) {
        best = best == null ? top : Math.max(best, top);
      }
    }

    if (z > MIN_LEVEL) {
      let below = getStack(map, x, y, z - 1);
      if (exclude && exclude.z === z - 1) {
        below = sceneryStack(map, x, y, z - 1, exclude.stackIndex);
      }
      if (stackHeight(below, tilesById) >= HEIGHT_PER_LEVEL) {
        const floorAbs = z * HEIGHT_PER_LEVEL;
        if (floorAbs < feetAbs) {
          best = best == null ? floorAbs : Math.max(best, floorAbs);
        }
      }
    }
  }

  return best;
}

export function destCellAfterStep(
  fromZ: number,
  destX: number,
  destY: number,
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Coord {
  const destStack = getStack(map, destX, destY, fromZ);
  const elev = stackHeight(destStack, tilesById);
  const { z } = normalizeStandingCell(fromZ, elev);
  return { x: destX, y: destY, z };
}

export type WalkCheck = { ok: true; to: Coord } | { ok: false; reason: string };

export type CanWalkOpts = {
  preferDescend?: boolean;
};

function climbUpAllowed(
  map: MapFile,
  from: Coord & { stackIndex: number },
  fromAbs: number,
  destAbs: number,
  direction: Direction,
  tilesById: Record<string, TileDef>,
): boolean {
  if (destAbs <= fromAbs) return true;
  const source = climbFromSourceAt(map, from.x, from.y, fromAbs, tilesById, {
    z: from.z,
    stackIndex: from.stackIndex,
  });
  if (!source) return true;
  const flags = resolveClimbFrom(source.def, source.direction);
  return flags[direction];
}

export function canWalk(
  map: MapFile,
  from: Coord & { stackIndex: number },
  direction: Direction,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  opts?: CanWalkOpts,
): WalkCheck {
  const { dx, dy } = DIR_DELTA[direction];
  const destX = from.x + dx;
  const destY = from.y + dy;

  const fromAbs = standingAbs(map, from.x, from.y, from.z, from.stackIndex, tilesById);

  const candidates = surfacesInClimbBand(
    map,
    { x: from.x, y: from.y, abs: fromAbs },
    destX,
    destY,
    tilesById,
  ).sort((a, b) => (opts?.preferDescend ? a.abs - b.abs : b.abs - a.abs));

  const fit: FitOpts = { throughPlayers: tileDef.id === PLAYER_TILE_ID };

  for (const surface of candidates) {
    if (!climbUpAllowed(map, from, fromAbs, surface.abs, direction, tilesById)) {
      continue;
    }

    const room = fitsAtElevation(map, destX, destY, surface.abs, tileDef, tilesById, fit);
    if (!room.ok) continue;

    return { ok: true, to: { x: destX, y: destY, z: surface.z } };
  }

  const room = fitsTile(map, destX, destY, from.z, tileDef, tilesById, fit);
  if (!room.ok) return room;

  const destScenery = getStack(map, destX, destY, from.z);
  const destAbs = absoluteStandingElevation(from.z, destScenery, tilesById);
  const climb = destAbs - fromAbs;
  if (climb > MAX_CLIMB_HEIGHT) {
    return { ok: false, reason: `Climb ${climb} exceeds max ${MAX_CLIMB_HEIGHT}` };
  }

  /**
   * `destAbs + 1` includes a solid top that coincides with `destAbs` itself —
   * a tree whose top sits exactly at the empty level above it — so standing
   * and falling share this one check instead of missing that case.
   */
  const restAbs = findLandingAbs(map, destX, destY, destAbs + 1, tilesById);
  if (restAbs != null && !isWalkableSurfaceAt(map, destX, destY, restAbs, tilesById)) {
    return { ok: false, reason: "Destination surface is not walkable" };
  }

  if (!climbUpAllowed(map, from, fromAbs, destAbs, direction, tilesById)) {
    return { ok: false, reason: "Climb-from blocked in that direction" };
  }

  const to = destCellAfterStep(from.z, destX, destY, map, tilesById);
  if (to.z !== from.z) {
    const roomUp = fitsTile(map, to.x, to.y, to.z, tileDef, tilesById, fit);
    if (!roomUp.ok) return roomUp;
  }

  return { ok: true, to };
}
