import { appendTile, getStack, listCoords, removeTileAt, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, levelKey, parseCoordKey, resolveActor } from "../lib/types";
import { PLAYER_TILE_ID } from "./constants";
import { requireSinglePlayer } from "./player";

export type ActorLocation = Coord & {
  stackIndex: number;
  placed: PlacedTile;
};

export const DEFAULT_FACING: Direction = "s";

const ACTOR_SEARCH_RADIUS = 1;

function isActor(placed: PlacedTile | undefined, ownerId: string): boolean {
  return placed?.owner === ownerId;
}

export function actorStillAt(
  map: MapFile,
  ownerId: string,
  at: Coord & { stackIndex: number },
): ActorLocation | null {
  const placed = getStack(map, at.x, at.y, at.z)[at.stackIndex];
  if (!isActor(placed, ownerId)) return null;
  return { x: at.x, y: at.y, z: at.z, stackIndex: at.stackIndex, placed };
}

export function findActorNear(map: MapFile, ownerId: string, near: Coord): ActorLocation | null {
  const r = ACTOR_SEARCH_RADIUS;
  for (let z = near.z - r; z <= near.z + r; z++) {
    if (z < MIN_LEVEL || z > MAX_LEVEL) continue;
    for (let y = near.y - r; y <= near.y + r; y++) {
      for (let x = near.x - r; x <= near.x + r; x++) {
        const stack = getStack(map, x, y, z);
        const i = stack.findIndex((p) => isActor(p, ownerId));
        if (i >= 0) return { x, y, z, stackIndex: i, placed: stack[i]! };
      }
    }
  }
  return null;
}

export function findActorAnywhere(map: MapFile, ownerId: string): ActorLocation | null {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (!level) continue;
    for (const chunk of Object.values(level)) {
      for (const key in chunk) {
        const stack = chunk[key]!;
        for (let i = 0; i < stack.length; i++) {
          if (stack[i]!.owner !== ownerId) continue;
          const { x, y } = parseCoordKey(key);
          return { x, y, z, stackIndex: i, placed: stack[i]! };
        }
      }
    }
  }
  return null;
}

export function locateActor(
  map: MapFile,
  ownerId: string,
  lastSeen?: Coord & { stackIndex: number },
): ActorLocation | null {
  if (lastSeen) {
    const stillThere = actorStillAt(map, ownerId, lastSeen);
    if (stillThere) return stillThere;
    const nearby = findActorNear(map, ownerId, lastSeen);
    if (nearby) return nearby;
  }
  return findActorAnywhere(map, ownerId);
}

export function spawnPoint(map: MapFile): Coord & { stackIndex: number } {
  const authored = requireSinglePlayer(map);
  return {
    x: authored.x,
    y: authored.y,
    z: authored.z,
    stackIndex: authored.stackIndex,
  };
}

export function adoptAuthoredPlayer(map: MapFile, ownerId: string): MapFile {
  return adoptBodyAt(map, requireSinglePlayer(map), ownerId);
}

export function listActorOwners(map: MapFile): string[] {
  const owners = new Set<string>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { stack } of listCoords(map, z)) {
      for (const placed of stack) {
        if (placed.owner) owners.add(placed.owner);
      }
    }
  }
  return [...owners];
}

export function listResidentBodies(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): ActorLocation[] {
  const found: ActorLocation[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      stack.forEach((placed, stackIndex) => {
        if (placed.tileId === PLAYER_TILE_ID) return;
        const def = tilesById[placed.tileId];
        if (!def || !resolveActor(def)) return;
        found.push({ x, y, z, stackIndex, placed });
      });
    }
  }
  return found;
}

export function residentOwnerId(at: Coord & { stackIndex: number }): string {
  return `${RESIDENT_ID_PREFIX}${at.x},${at.y},${at.z},${at.stackIndex}`;
}

const RESIDENT_ID_PREFIX = "npc:";

export function residentHome(ownerId: string): Coord | null {
  if (!ownerId.startsWith(RESIDENT_ID_PREFIX)) return null;
  const parts = ownerId.slice(RESIDENT_ID_PREFIX.length).split(",");
  if (parts.length !== 4) return null;
  const [x, y, z] = parts.map(Number);
  if (x === undefined || y === undefined || z === undefined) return null;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

export function adoptBodyAt(
  map: MapFile,
  at: Coord & { stackIndex: number },
  ownerId: string,
): MapFile {
  const stack = getStack(map, at.x, at.y, at.z);
  const next = stack.map((placed, i) =>
    i === at.stackIndex ? { ...placed, owner: ownerId } : placed,
  );
  return replaceStack(map, at.x, at.y, at.z, next);
}

export function removeAuthoredPlayer(map: MapFile): MapFile {
  const at = requireSinglePlayer(map);
  return removeTileAt(map, at.x, at.y, at.z, at.stackIndex);
}

export function spawnActor(
  map: MapFile,
  ownerId: string,
  at: Coord,
  direction: Direction = DEFAULT_FACING,
): MapFile {
  return appendTile(map, at.x, at.y, at.z, {
    tileId: PLAYER_TILE_ID,
    direction,
    owner: ownerId,
  });
}

export function despawnActor(map: MapFile, ownerId: string): MapFile {
  const loc = findActorAnywhere(map, ownerId);
  if (!loc) return map;
  return removeTileAt(map, loc.x, loc.y, loc.z, loc.stackIndex);
}

export function actorDirection(loc: ActorLocation): Direction {
  return loc.placed.direction ?? DEFAULT_FACING;
}
