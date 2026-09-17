import type { ActorSnapshot } from "../game/GameSession";
import { sceneryStack } from "../game/movement";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { stackHeight } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type Coord, type MapFile, type TileDef } from "../lib/types";

/**
 * Absolute elevation of the surface a placed tile is standing on.
 *
 * Scenery only: the tile at `stackIndex` is what is standing there, so counting
 * its own height would put it on top of itself.
 */
export function standingFootAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: Coord,
  stackIndex: number,
): number {
  const scenery = sceneryStack(map, cell.x, cell.y, cell.z, stackIndex);
  return cell.z * HEIGHT_PER_LEVEL + stackHeight(scenery, tilesById);
}

/**
 * How far below its map anchor a falling sprite is drawn, in world pixels.
 *
 * A fall runs in absolute height units, but the map can only stand a tile on
 * a surface, so feet part-way up a level are placed on the level below. Adding
 * only the progress through the current unit to that anchor drew every other
 * unit of the drop a unit too low. The offset is instead the distance between
 * where the fall says the feet are and where the map put them, which also
 * matches the depth box computed from the same absolute feet.
 */
export function fallDropPx(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: ActorSnapshot,
): number {
  if (!actor.fall) return 0;
  const anchorFoot = standingFootAbs(map, tilesById, actor, actor.stackIndex);
  return (anchorFoot - fallFootAbs(actor)) * PX_PER_HEIGHT;
}

/**
 * Absolute elevation of a falling actor's feet, part-way through a unit.
 *
 * `fallProgress` may run slightly past 1 — it extrapolates into the tick that
 * has not committed the next height step yet, which is what keeps the descent
 * continuous instead of stalling at every boundary. The landing is the one
 * place that must not be extrapolated through: past it there is floor.
 */
export function fallFootAbs(actor: ActorSnapshot): number {
  const fall = actor.fall;
  if (!fall) return 0;
  return Math.max(fall.landingAbs, fall.feetAbs - actor.fallProgress);
}
