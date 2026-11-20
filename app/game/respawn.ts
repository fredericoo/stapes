import { resolveActor } from "../lib/types";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import type { ItemInstance } from "../lib/itemInstance";
import { resolveRespawn, type RespawnInteraction } from "../lib/interactions";
import {
  absoluteStandingElevation,
  getStack,
  isBodyPlacement,
  isWalkableSurfaceAt,
  listCoords,
  presentLevels,
} from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import { canPlace } from "../lib/validation";
import { findActorAnywhere } from "./actors";
import { isSupported } from "./gravity";
import { unsafeToStepOn, wadesIn } from "./pathfinding";
import { cellKey } from "./pressurePlates";

export const MAX_SPAWN_RADIUS = 12;

export type SpawnPoint = {
  key: string;
  cell: Coord;
  respawn: RespawnInteraction;
  placed: PlacedTile;
  ownerId?: string;
  count?: number;
  itemIds?: string[];
};

export type RespawnOutcome = { kind: "done"; itemId?: string } | { kind: "blocked" };

export function rollRespawnDelayMs(respawn: RespawnInteraction, random: () => number): number {
  const spread = respawn.toMs - respawn.fromMs + 1;
  return respawn.fromMs + Math.floor(random() * spread);
}

function remintable(instance: ItemInstance): ItemInstance {
  const { id: _id, ...rest } = instance;
  return rest as ItemInstance;
}

function authoredPlacement(placed: PlacedTile): PlacedTile {
  const { owner: _owner, itemId: _itemId, ...rest } = placed;
  return {
    ...rest,
    ...(rest.contents ? { contents: rest.contents.map(remintable) } : {}),
  };
}

function objectKey(cell: Coord, tileId: string): string {
  return `obj:${cellKey(cell)}|${tileId}`;
}

export function findSpawnPoints(map: MapFile, tilesById: Record<string, TileDef>): SpawnPoint[] {
  const points = new Map<string, SpawnPoint>();
  for (const z of presentLevels(map)) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const cell = { x, y, z };
      stack.forEach((placed) => {
        const def = tilesById[placed.tileId];
        const respawn = def ? resolveRespawn(def) : null;
        if (!def || !respawn) return;

        if (resolveActor(def)) {
          /** A body nobody has adopted has no id to come back under. */
          const ownerId = placed.owner;
          if (!ownerId) return;
          points.set(ownerId, {
            key: ownerId,
            cell,
            respawn,
            placed: authoredPlacement(placed),
            ownerId,
          });
          return;
        }

        const key = objectKey(cell, placed.tileId);
        const existing = points.get(key);
        if (existing) {
          existing.count = (existing.count ?? 1) + 1;
          if (placed.itemId) {
            existing.itemIds = [...(existing.itemIds ?? []), placed.itemId];
          }
        } else {
          points.set(key, {
            key,
            cell,
            respawn,
            placed: authoredPlacement(placed),
            count: 1,
            ...(placed.itemId ? { itemIds: [placed.itemId] } : {}),
          });
        }
      });
    }
  }
  return [...points.values()];
}

export function presentItemIds(map: MapFile, point: SpawnPoint): string[] {
  const owed = new Set(point.itemIds ?? []);
  if (owed.size === 0) return [];
  return getStack(map, point.cell.x, point.cell.y, point.cell.z).flatMap((placed) =>
    placed.itemId && owed.has(placed.itemId) ? [placed.itemId] : [],
  );
}

/**
 * A creature's point sweeps the whole board here; `GameSession.isSpawnFilled`
 * answers the same question from its actors.
 */
export function isSpawnFilled(map: MapFile, point: SpawnPoint): boolean {
  if (point.ownerId) return findActorAnywhere(map, point.ownerId) !== null;
  const owed = point.count ?? 1;
  if (point.itemIds) return presentItemIds(map, point).length >= owed;
  const present = getStack(map, point.cell.x, point.cell.y, point.cell.z).filter(
    (placed) => placed.tileId === point.placed.tileId,
  ).length;
  return present >= owed;
}

export function withMigratedItemIds(map: MapFile, point: SpawnPoint): SpawnPoint {
  if (point.ownerId || point.itemIds) return point;
  const itemIds = getStack(map, point.cell.x, point.cell.y, point.cell.z).flatMap((placed) =>
    placed.tileId === point.placed.tileId && placed.itemId ? [placed.itemId] : [],
  );
  return itemIds.length > 0 ? { ...point, itemIds } : point;
}

/** Only a creature's point can scatter: an object's point counts what is left in its own cell. */
export function spawnRadiusOf(point: SpawnPoint): number {
  const radius = point.placed.spawnRadius;
  if (!point.ownerId || radius === undefined || !Number.isInteger(radius) || radius <= 0) return 0;
  return Math.min(radius, MAX_SPAWN_RADIUS);
}

export function spawnAreaCells(centre: Coord, radius: number): Coord[] {
  const cells: Coord[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      cells.push({ x: centre.x + dx, y: centre.y + dy, z: centre.z });
    }
  }
  return cells;
}

/**
 * Stricter than the `canPlace` a point without an area asks of its authored
 * cell, because nobody chose these cells: one also needs ground the body could
 * have walked onto, nobody already in it, nothing harmful underfoot, and no
 * water for a body that does not swim.
 */
export function canSpawnBodyAt(
  map: MapFile,
  at: Coord,
  def: TileDef,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  direction?: Direction,
): boolean {
  const stack = getStack(map, at.x, at.y, at.z);
  if (stack.some((placed) => isBodyPlacement(placed, tilesById))) return false;
  if (!isSupported(map, at.x, at.y, at.z, stack.length, tilesById)) return false;
  const groundAbs = absoluteStandingElevation(at.z, stack, tilesById);
  if (!isWalkableSurfaceAt(map, at.x, at.y, groundAbs, tilesById)) return false;
  if (!def.swims && wadesIn(map, at, tilesById)) return false;
  if (unsafeToStepOn(map, at, tilesById, statusDefs, def)) return false;
  return canPlace(map, at.x, at.y, at.z, def, tilesById, direction).ok;
}
