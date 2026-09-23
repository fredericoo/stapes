import {
  absoluteStandingElevation,
  climbFromSourceAt,
  footingOfStack,
  getStack,
  isSolidPlacement,
  isWalkableSurfaceAt,
  planeCoveredBy,
  stackHeight,
  surfaceTileAt,
  walkableFloorAbove,
} from "../lib/mapData";
import { stackOcclusion } from "../lib/lighting";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, resolveClimbFrom } from "../lib/types";
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
 * How long one step takes this body when nothing is in its way, in
 * milliseconds. The pace it is authored at, before a status or the ground has
 * moved it — see {@link walkDurationMsFor}, which is what times an actual step.
 *
 * Lives beside the movement rules rather than in the tile module because both
 * ends of the wire need it and neither should have to guess: the simulation
 * times the step with it, and the client divides by it to place the sprite. It
 * never travels — a client already knows which tile an actor is, so deriving it
 * on both sides is cheaper than a field on every walk event, and cannot
 * disagree. **That bargain is the constraint on everything allowed to move a
 * pace**: a source the browser cannot read for itself would have to travel, and
 * it is why a status's share of this is a plain number rather than a formula.
 */
export function resolveWalkDurationMs(def: TileDef): number {
  const authored = def.walkDurationMs;
  return authored != null && authored > 0 ? authored : WALK_DURATION_MS;
}

/**
 * How long one step actually takes, with everything slowing or hurrying this
 * body counted in.
 *
 * {@link resolveWalkDurationMs} is what the body is authored at; this is what
 * it is walking at now. The split is worth keeping because the two have
 * different readers: a pace that must not change with circumstance reads the
 * first — see `./combat`'s `strikeRecoveryMs`, where how long a blow plants you
 * is a fact about the swing — and everything that times an actual step reads
 * this.
 *
 * The percentage is passed in rather than gathered here, because the sources
 * are not this module's to know: one is the statuses on the body and one is the
 * ground under it, and only the caller holds both. @see `../lib/walkSpeed`
 */
export function walkDurationMsFor(def: TileDef, speedPercent: number): number {
  return walkDurationFrom(resolveWalkDurationMs(def), speedPercent);
}

/**
 * How much quicker or slower the ground under this body makes it walk.
 *
 * **The surface its feet are on, and never the cell it is stepping into.** Both
 * ends of the wire have to reach the same figure, and the cell being *left* is
 * the one they agree about: the browser is told a step has started and holds
 * the board it started from, where the destination may be a cell it is about to
 * be patched. It also reads better than the alternative — wading out of a bog
 * is slow, and the step that gets you clear of it is the last slow one.
 *
 * The body is excluded from its own stack, on {@link standingAbs}'s terms: what
 * is being asked about is what it is standing on, and a body is not its own
 * ground.
 *
 * Zero for open air, for a tile nobody authored a figure onto, and for a
 * placement of something the catalogue no longer holds — the same reading every
 * other absent field takes.
 */
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

/**
 * Whether this body is standing in a `wade` tile — shallow water, or another
 * liquid shallow enough to walk through. @see TileDef.wade
 *
 * The surface under its feet on {@link groundWalkSpeedPercent}'s terms, with
 * the body excluded from its own stack.
 */
export function wadesAt(
  map: MapFile,
  at: Coord & { stackIndex: number },
  tilesById: Record<string, TileDef>,
): boolean {
  const abs = standingAbs(map, at.x, at.y, at.z, at.stackIndex, tilesById);
  return surfaceWades(map, at.x, at.y, abs, tilesById, { z: at.z, stackIndex: at.stackIndex });
}

/**
 * Whether the surface at `abs` in column (x, y) is a `wade` tile.
 *
 * {@link wadesAt} for a cell nobody is standing in yet — the far end of a step,
 * where the body has to be drawn sinking before the simulation has put it there.
 */
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
  /** Absolute elevation of the standing surface. */
  abs: number;
  /** Level where an entity standing here should be stored. */
  z: number;
};

/**
 * All walkable standing surfaces in column (x,y): highest walkable tile top
 * per stack, and floors formed by a full level below.
 *
 * **A plane something unstandable is lying on is not one of them, whoever else
 * claims it.** Water is `height: 0`, so a pond contributes no surface of its
 * own and used only to be a claim nobody made — leaving a full walkable level
 * under it to answer for the cell with the very plane the water sits in, which
 * is how you could walk across a pond laid on a stone floor. Collected as the
 * scan goes and applied at the end, because a plane is closed from *above* and
 * the level that claims it comes round first. @see planeCoveredBy
 */
export function listStandingSurfaces(
  map: MapFile,
  x: number,
  y: number,
  tilesById: Record<string, TileDef>,
): StandingSurface[] {
  const out: StandingSurface[] = [];
  /** Planes a level's own stack has closed. @see planeCoveredBy */
  let closed: number[] | undefined;

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

  // The level below's stack, carried up from the pass before rather than read
  // again: every step anybody takes reads a whole column here.
  let below: PlacedTile[] | null = null;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const stack = getStack(map, x, y, z);
    if (stack.length > 0) {
      // One scan for both questions, and read before anything else can ask
      // again — the footing object is reused. @see footingOfStack
      const footing = footingOfStack(stack, tilesById);
      if (planeCoveredBy(footing)) (closed ??= []).push(z * HEIGHT_PER_LEVEL);
      if (footing?.walkable) add(z * HEIGHT_PER_LEVEL + footing.elev, z);
    }
    if (below !== null) {
      const floorAbs = walkableFloorAbove(z - 1, below, tilesById);
      if (floorAbs != null) add(floorAbs, z);
    }
    below = stack;
  }
  if (!closed) return out;
  return out.filter((surface) => !closed.includes(surface.abs));
}

/**
 * Does travelling straight up or down between `fromAbs` and `toAbs` in column
 * (x, y) pass through a floor somebody has laid there?
 *
 * A level's floor plane sits at `z * HEIGHT_PER_LEVEL`, and it is sealed when
 * anything solid stands in that level's cell — `sealsLevel`, the same fact that
 * decides whether light and a look may travel vertically, so a walk cannot
 * disagree with either about what a ceiling is. A light-passing tile seals
 * nothing, which is what keeps a ladder shaft and a pond bottom open.
 *
 * Planes strictly above the lower end and up to the higher end count. The
 * plane a body finishes standing *on* is the one it arrives at, not one it went
 * through, and the plane under its feet at the start is not between it and
 * anywhere.
 */
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

/** Where a step starts: the column being left, and the feet's elevation in it. */
export type StepOrigin = { x: number; y: number; abs: number };

/**
 * Surfaces at (x,y) a body standing at `from` could step onto.
 *
 * The climb band, less anything the step would have to pass through a floor to
 * reach — and nothing else: no fit check, no direction, no opinion about what is
 * standing there. That narrowness is what lets three callers share it:
 * {@link canWalk} picks the surface it will land on, a creature asks whether a
 * step this way would leave it in mid-air, and a route search asks the same
 * question one cell ahead of where anybody is standing.
 *
 * **A step never crosses a sealed floor plane.** The band alone let a body
 * change level through a ceiling: a lone half-block under a bare floor is two
 * units below that floor, which is exactly a climb, so a rat on it stepped up
 * through the ground onto the grass and a snake on the grass stepped down
 * through it onto the block. Which column the vertical travel happens in is
 * the whole of the rule. A step *up* rises in the column being left — that is
 * what makes a ramp work at all: the cell over it is empty, so a body climbs
 * out of the hole onto the floor beside it, while the same climb from under a
 * ceiling is refused. A step *down* drops in the column being entered — into
 * the den mouth, where nothing is overhead, and not through the field next to
 * it. Measuring the drop in the column being left would find the very floor
 * the body is standing on and refuse every step off a ledge.
 *
 * Empty means open air. The board deliberately allows walking into it so
 * gravity can pull an actor through a steeper drop, so an empty answer is a
 * *caution* rather than a refusal, and whose caution it is belongs to the
 * caller.
 */
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

/**
 * Highest solid surface absolute elevation strictly below `feetAbs` at (x,y).
 * Includes non-walkable tops (caller may slide or fall through).
 * Returns null if nothing is below (open void).
 */
export function findLandingAbs(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tilesById: Record<string, TileDef>,
  /** Stack index of falling entity at its current cell, if on this column. */
  exclude?: { z: number; stackIndex: number },
): number | null {
  let best: number | null = null;

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = sceneryStack(map, x, y, z, exclude.stackIndex);
    }

    // A stack of nothing but intangibles is open air with art in it, and its
    // "top" is the bare level base — landing on that is how a body came to
    // hover in a ladder shaft with no floor under it.
    if (stack.some((placed) => isSolidPlacement(placed, tilesById))) {
      const top = absoluteStandingElevation(z, stack, tilesById);
      if (top < feetAbs) {
        best = best == null ? top : Math.max(best, top);
      }
    }

    // Full stack below forms a floor at the base of this level.
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

export type WalkCheck = { ok: true; to: Coord } | { ok: false; reason: string };

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

  const fromAbs = standingAbs(map, from.x, from.y, from.z, from.stackIndex, tilesById);

  const candidates = surfacesInClimbBand(
    map,
    { x: from.x, y: from.y, abs: fromAbs },
    destX,
    destY,
    tilesById,
  ).sort((a, b) => (opts?.preferDescend ? a.abs - b.abs : b.abs - a.abs));

  // People walk through each other; nothing else walks through anybody. See
  // `../lib/validation`'s `FitOpts`, which is where that rule is written down.
  const fit: FitOpts = { throughPlayers: tileDef.id === PLAYER_TILE_ID };

  for (const surface of candidates) {
    if (!climbUpAllowed(map, from, fromAbs, surface.abs, direction, tilesById)) {
      continue;
    }

    const room = fitsAtElevation(map, destX, destY, surface.abs, tileDef, tilesById, fit);
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

  // Refuse a step whose body would come to rest on a top nobody can stand on,
  // however far down the fall takes it. `destAbs + 1` makes the search include
  // a top at `destAbs` itself — a full-height tree whose top coincides with an
  // empty level's base above it — so standing and falling are one check.
  //
  // This used to stop at `destAbs`, and a body that fell onto a fence was
  // walked on in the direction it faced until it found somewhere to land. The
  // client predicts steps and not that walk, so the body snapped to wherever
  // the server put it. Refusing the step here refuses it on both machines.
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
