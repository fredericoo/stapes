import { resolveActor, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import type { ItemInstance } from "../lib/itemInstance";
import { resolveRespawn, type RespawnInteraction } from "../lib/interactions";
import { getStack, listCoords } from "../lib/mapData";
import { findActorAnywhere, residentOwnerId } from "./actors";
import { cellKey } from "./pressurePlates";

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

export function rollRespawnDelayMs(
  respawn: RespawnInteraction,
  random: () => number = Math.random,
): number {
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
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const cell = { x, y, z };
      stack.forEach((placed, stackIndex) => {
        const def = tilesById[placed.tileId];
        const respawn = def ? resolveRespawn(def) : null;
        if (!def || !respawn) return;

        if (resolveActor(def)) {
          const ownerId = placed.owner ?? residentOwnerId({ ...cell, stackIndex });
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

export function isSpawnFilled(map: MapFile, point: SpawnPoint): boolean {
  if (point.ownerId) {
    return findActorAnywhere(map, point.ownerId) !== null;
  }
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
