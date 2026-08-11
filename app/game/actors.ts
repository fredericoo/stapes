import { appendTile, getStack, listCoords, removeTileAt, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, resolveActor } from "../lib/types";
import { PLAYER_TILE_ID } from "./constants";
import { requireSinglePlayer } from "./player";

/** A placed player tile plus who drives it. */
export type ActorLocation = Coord & {
  stackIndex: number;
  placed: PlacedTile;
};

/** Facing a freshly spawned actor takes, matching the authored default. */
const DEFAULT_FACING: Direction = "s";

/**
 * Cells searched around a last-known location before falling back to a sweep.
 * A commit moves an actor one cell, or one level when falling — never across
 * the map.
 */
const ACTOR_SEARCH_RADIUS = 1;

/**
 * An actor is any placement carrying an owner — the tile it happens to be is
 * not part of the test.
 *
 * This used to insist on the `player` tile, which was true while a socket was
 * the only thing that could drive a body. An owner now means "something is
 * driving this", whether that something is a connection or an authored brain,
 * so the tile id has no bearing on it.
 */
function isActor(placed: PlacedTile | undefined, ownerId: string): boolean {
  return placed?.owner === ownerId;
}

/**
 * Re-read an actor at a location it was last seen, or null if it moved.
 *
 * Most map edits do not move anyone — a plate pressing underfoot, a door
 * elsewhere — so checking the one cell beats rediscovering them.
 */
export function actorStillAt(
  map: MapFile,
  ownerId: string,
  at: Coord & { stackIndex: number },
): ActorLocation | null {
  const placed = getStack(map, at.x, at.y, at.z)[at.stackIndex];
  if (!isActor(placed, ownerId)) return null;
  return { x: at.x, y: at.y, z: at.z, stackIndex: at.stackIndex, placed };
}

/** Find an actor near where they were last seen, or null to force a sweep. */
export function findActorNear(
  map: MapFile,
  ownerId: string,
  near: Coord,
): ActorLocation | null {
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

/**
 * Sweep every level for an actor. The fallback of last resort — see
 * {@link locateActor}, which reaches this only when someone has genuinely been
 * relocated across the map.
 */
export function findActorAnywhere(
  map: MapFile,
  ownerId: string,
): ActorLocation | null {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const i = stack.findIndex((p) => isActor(p, ownerId));
      if (i >= 0) return { x, y, z, stackIndex: i, placed: stack[i]! };
    }
  }
  return null;
}

/**
 * Locate an actor, cheapest test first: the cell they were in, then the
 * neighbourhood, then the whole board.
 *
 * A single tick can rewrite the map several times — commit a step, then settle
 * a plate under it — and nearly all of those edits leave everyone exactly where
 * they were. Sweeping for each would put an O(map) pass on the busiest frames.
 */
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

/**
 * Where actors enter the world: the cell holding the authored `player` tile.
 *
 * An authored map carries exactly one, and it is a spawn marker rather than a
 * participant — every actor starts there.
 */
export function spawnPoint(map: MapFile): Coord & { stackIndex: number } {
  const authored = requireSinglePlayer(map);
  return {
    x: authored.x,
    y: authored.y,
    z: authored.z,
    stackIndex: authored.stackIndex,
  };
}

/**
 * Tag the authored `player` tile as belonging to `ownerId`, in place.
 *
 * Adoption rather than remove-and-respawn so the tile keeps its slot in the
 * stack: re-appending would move it to the top, changing its stackIndex and
 * with it the elevation it stands at.
 */
export function adoptAuthoredPlayer(map: MapFile, ownerId: string): MapFile {
  return adoptBodyAt(map, requireSinglePlayer(map), ownerId);
}

/**
 * Every actor with a tile on the board.
 *
 * A resumed world can hold actors nobody is driving any more — a connection
 * that died while the object was evicted leaves its body behind — so the server
 * needs to know who is present before deciding who belongs.
 */
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

/**
 * Bodies that live in the map rather than arriving on a socket.
 *
 * Every placement of a tile marked {@link TileDef.actor}, minus the authored
 * `player` tile — which wears the same flag because it *is* a body, but is a
 * spawn marker the session consumes rather than a resident of the world. A
 * connected player's body is excluded by the same test, which is correct: they
 * are driven by their connection, and this is the list of everyone who is not.
 *
 * Returned with owners intact where they have them. A resumed world already
 * carries the owners minted the first time it loaded, and re-minting would hand
 * the same deer a second identity.
 */
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

/**
 * The identity a resident body takes when it is first adopted.
 *
 * Derived from where it was authored, because that reads in a log in a way a
 * counter does not, and because it is stable across reloads of the same map.
 * The stack slot is part of it so that two bodies in one cell — a cat asleep on
 * a crate — do not collide. It stops describing where they are the moment they
 * move, which is fine: it is a name, not an address.
 */
export function residentOwnerId(at: Coord & { stackIndex: number }): string {
  return `npc:${at.x},${at.y},${at.z},${at.stackIndex}`;
}

/** Tag a placement as belonging to `ownerId`, keeping its slot in the stack. */
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

/**
 * Take the authored `player` tile off the board, keeping its cell as the spawn
 * point. For a session that starts empty: the tile is only a marker, and
 * leaving it would draw an avatar nobody is driving.
 */
export function removeAuthoredPlayer(map: MapFile): MapFile {
  const at = requireSinglePlayer(map);
  return removeTileAt(map, at.x, at.y, at.z, at.stackIndex);
}

/**
 * Put a new actor on top of the stack at `at`.
 *
 * `direction` is carried for a returning player, whose facing is part of where
 * they were; a genuinely new actor takes the authored default.
 */
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

/** Take an actor's tile off the board. A no-op when they are not on it. */
export function despawnActor(map: MapFile, ownerId: string): MapFile {
  const loc = findActorAnywhere(map, ownerId);
  if (!loc) return map;
  return removeTileAt(map, loc.x, loc.y, loc.z, loc.stackIndex);
}

export function actorDirection(loc: ActorLocation): Direction {
  return loc.placed.direction ?? DEFAULT_FACING;
}
