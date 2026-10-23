import { type AreaShape, areaOffsets, inAreaShape } from "../lib/area";
import type { AreaBurst } from "../lib/item";
import { footingOfStack, getStack } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type MapFile, type TileDef } from "../lib/types";
import { heightApart, type ReachPoint } from "./distance";
import type { FlightEffect, FlightPoint } from "./projectile";
import { hasLineOfSight } from "./sight";

export type AreaCentre = ReachPoint & { z: number };

export type AreaReach = {
  shape: AreaShape;
  radius: number;
  height: number;
  throughWalls: boolean;
};

export function reachesInArea(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  centre: AreaCentre,
  body: AreaCentre,
  area: AreaReach,
): boolean {
  if (!inAreaShape(area.shape, area.radius, body.x - centre.x, body.y - centre.y)) return false;
  if (heightApart(centre, body) > area.height) return false;
  return area.throughWalls || hasLineOfSight(map, tilesById, centre, body);
}

/**
 * The ground the area covers, one point per cell, for drawing it: in each
 * cell, the footing nearest the centre's on its level or the ones either side.
 * A cell whose nearest footing is further than `height` away is left out.
 */
export function areaFloorCells(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  centre: AreaCentre,
  area: Pick<AreaReach, "shape" | "radius" | "height">,
): FlightPoint[] {
  const out: FlightPoint[] = [];
  for (const { dx, dy } of areaOffsets(area.shape, area.radius)) {
    const x = centre.x + dx;
    const y = centre.y + dy;
    const elevAbs = floorNear(map, tilesById, x, y, centre);
    if (elevAbs === null || Math.abs(elevAbs - centre.elevAbs) > area.height) continue;
    out.push({ x, y, elevAbs });
  }
  return out;
}

const NEARBY_LEVELS = [1, 0, -1] as const;

function floorNear(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  centre: AreaCentre,
): number | null {
  let nearest: number | null = null;
  for (const dz of NEARBY_LEVELS) {
    const z = centre.z + dz;
    const footing = footingOfStack(getStack(map, x, y, z), tilesById);
    if (!footing) continue;
    const elevAbs = z * HEIGHT_PER_LEVEL + footing.elev;
    if (
      nearest === null ||
      Math.abs(elevAbs - centre.elevAbs) < Math.abs(nearest - centre.elevAbs)
    ) {
      nearest = elevAbs;
    }
  }
  return nearest;
}

export function areaBurstEffects(
  id: string,
  cells: readonly FlightPoint[],
  burst: AreaBurst,
): FlightEffect[] {
  if (cells.length === 0) return [];
  const ratePerSecond = burst.particles.ratePerSecond / cells.length;
  const transition = {
    durationMs: burst.durationMs,
    particles: { ...burst.particles, ratePerSecond },
  };
  return cells.map((at, i) => ({
    id: `${id}:${i}`,
    at,
    transition,
    elapsedMs: 0,
    startDebt: i / cells.length,
  }));
}

export type AreaBurstNote = {
  id: string;
  x: number;
  y: number;
  cells: FlightPoint[];
  burst: AreaBurst;
};
