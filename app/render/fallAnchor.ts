import type { ActorSnapshot } from "../game/GameSession";
import { sceneryStack } from "../game/movement";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { stackHeight } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type Coord, type MapFile, type TileDef } from "../lib/types";

export function standingFootAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cell: Coord,
  stackIndex: number,
): number {
  const scenery = sceneryStack(map, cell.x, cell.y, cell.z, stackIndex);
  return cell.z * HEIGHT_PER_LEVEL + stackHeight(scenery, tilesById);
}

export function fallDropPx(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: ActorSnapshot,
): number {
  if (!actor.fall) return 0;
  const anchorFoot = standingFootAbs(map, tilesById, actor, actor.stackIndex);
  return (anchorFoot - fallFootAbs(actor)) * PX_PER_HEIGHT;
}

export function fallFootAbs(actor: ActorSnapshot): number {
  const fall = actor.fall;
  if (!fall) return 0;
  return Math.max(fall.landingAbs, fall.feetAbs - actor.fallProgress);
}
