import {
  absoluteStandingElevation,
  absoluteWalkableElevation,
  climbFromSourceAt,
  getStack,
  stackHeight,
  surfaceTileAt,
  walkableFloorAbove,
} from "../lib/mapData";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  resolveClimbFrom,
  resolveWalkable,
} from "../lib/types";
import type { FitOpts } from "../lib/validation";
import { fitsAtElevation, fitsTile } from "../lib/validation";
import {
  MAX_CLIMB_HEIGHT,
  PLAYER_TILE_ID,
  WALK_DURATION_MS,
} from "./constants";
import { normalizeStandingCell } from "./mapMutations";

export const DIR_DELTA: Record<Direction, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};

/** Stack at a cell with the entity at stackIndex removed (scenery only). */
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

/**
 * How long one step takes this body, in milliseconds.
 *
 * Lives beside the movement rules rather than in the tile module because both
 * ends of the wire need it and neither should have to guess: the simulation
 * times the step with it, and the client divides by it to place the sprite. It
 * never travels — a client already knows which tile an actor is, so deriving it
 * on both sides is cheaper than a field on every walk event, and cannot
 * disagree.
 */
export function resolveWalkDurationMs(def: TileDef): number {
  const authored = def.walkDurationMs;
  return authored != null && authored > 0 ? authored : WALK_DURATION_MS;
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
  /** Absolute elevation of the standing surface. */
  abs: number;
  /** Level where an entity standing here should be stored. */
  z: number;
};

/**
 * All walkable standing surfaces in column (x,y): highest walkable tile top
 * per stack, and floors formed by a full level below.
 */
export function listStandingSurfaces(
  map: MapFile,
  x: number,
  y: number,
  tilesById: Record<string, TileDef>,
): StandingSurface[] {
  const out: StandingSurface[] = [];

  // Same abs can be claimed by a lower stack top and an upper-level floor /
  // height-0 tile. Prefer the highest level — that owns the plane.
  const add = (abs: number, z: number) => {
    const existing = out.find((s) => s.abs === abs);
    if (existing) {
      if (z > existing.z) existing.z = z;
      return;
    }
    out.push({ abs, z });
  };

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const stack = getStack(map, x, y, z);
    if (stack.length > 0) {
      const walkAbs = absoluteWalkableElevation(z, stack, tilesById);
      if (walkAbs != null) add(walkAbs, z);
    }
    if (z > MIN_LEVEL) {
      const below = getStack(map, x, y, z - 1);
      const floorAbs = walkableFloorAbove(z - 1, below, tilesById);
      if (floorAbs != null) add(floorAbs, z);
    }
  }
  return out;
}

/**
 * Surfaces at (x,y) a body with its feet at `fromAbs` could step onto.
 *
 * The climb band and nothing else — no fit check, no direction, no opinion
 * about what is standing there. That narrowness is what lets three callers
 * share it: {@link canWalk} picks the surface it will land on, a creature asks
 * whether a step this way would leave it in mid-air, and a route search asks
 * the same question one cell ahead of where anybody is standing.
 *
 * Empty means open air. The board deliberately allows walking into it so
 * gravity can pull an actor through a steeper drop, so an empty answer is a
 * *caution* rather than a refusal, and whose caution it is belongs to the
 * caller.
 */
export function surfacesInClimbBand(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  tilesById: Record<string, TileDef>,
): StandingSurface[] {
  return listStandingSurfaces(map, x, y, tilesById).filter(
    (surface) =>
      surface.abs >= fromAbs - MAX_CLIMB_HEIGHT &&
      surface.abs <= fromAbs + MAX_CLIMB_HEIGHT,
  );
}

/** Scenery tile whose solid top is at absolute `abs`, if any. */
function solidTopAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  return surfaceTileAt(map, x, y, abs, tilesById);
}

/**
 * Dest cell for a same-level step, after normalizing promotion when the
 * surface is a full level or more.
 */
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

export type WalkCheck =
  | { ok: true; to: Coord }
  | { ok: false; reason: string };

export type CanWalkOpts = {
  /** Prefer lowest surface in the climb band (Option / Alt). */
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

/**
 * Can `tileDef` walk from its current cell one step in `direction`?
 * Vertical change within ±MAX_CLIMB_HEIGHT is a normal walk (including down a
 * level). Steeper drops walk onto the void and fall afterward.
 */
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

  const fromAbs = standingAbs(
    map,
    from.x,
    from.y,
    from.z,
    from.stackIndex,
    tilesById,
  );

  const candidates = surfacesInClimbBand(
    map,
    destX,
    destY,
    fromAbs,
    tilesById,
  ).sort((a, b) => (opts?.preferDescend ? a.abs - b.abs : b.abs - a.abs));

  // People walk through each other; nothing else walks through anybody. See
  // `../lib/validation`'s `FitOpts`, which is where that rule is written down.
  const fit: FitOpts = { throughPlayers: tileDef.id === PLAYER_TILE_ID };

  for (const surface of candidates) {
    if (
      !climbUpAllowed(
        map,
        from,
        fromAbs,
        surface.abs,
        direction,
        tilesById,
      )
    ) {
      continue;
    }

    const room = fitsAtElevation(
      map,
      destX,
      destY,
      surface.abs,
      tileDef,
      tilesById,
      fit,
    );
    if (!room.ok) continue;

    // Append onto the stack that forms this surface (surface.z), so feet stay
    // at surface.abs — including on overflowing plaster ladders.
    return { ok: true, to: { x: destX, y: destY, z: surface.z } };
  }

  // No surface within climb range — allow stepping onto this level's cell so
  // gravity can pull through a steeper drop (walk-into-hole).
  const room = fitsTile(map, destX, destY, from.z, tileDef, tilesById, fit);
  if (!room.ok) return room;

  const destScenery = getStack(map, destX, destY, from.z);
  const destAbs = absoluteStandingElevation(from.z, destScenery, tilesById);
  const climb = destAbs - fromAbs;
  if (climb > MAX_CLIMB_HEIGHT) {
    return { ok: false, reason: `Climb ${climb} exceeds max ${MAX_CLIMB_HEIGHT}` };
  }

  // Reject standing on a non-walkable solid top (including a full-height tree
  // whose top coincides with an empty level's base above it).
  const solidTop = solidTopAt(map, destX, destY, destAbs, tilesById);
  if (solidTop) {
    const topDef = tilesById[solidTop.tileId];
    if (topDef && !resolveWalkable(topDef)) {
      return { ok: false, reason: "Destination surface is not walkable" };
    }
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
