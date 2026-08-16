import { resolveActor, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import type { ItemInstance } from "../lib/itemInstance";
import { resolveRespawn, type RespawnInteraction } from "../lib/interactions";
import { getStack, listCoords } from "../lib/mapData";
import { findActorAnywhere, residentOwnerId } from "./actors";
import { cellKey } from "./pressurePlates";

/**
 * One authored placement of a respawning tile — where the world grows it back.
 *
 * Derived from the map a fresh world opens with (see `findSpawnPoints`) and
 * held by the server from then on, because the live map stops being able to
 * answer the question the moment the first creature dies: the placement is
 * gone, and what was authored there is exactly what a resumed checkpoint no
 * longer holds.
 *
 * Two trackings, split on {@link TileDef.actor}:
 *
 * - A **creature** is tracked by the identity it was adopted under
 *   ({@link residentOwnerId}) — it moves, so its authored cell says nothing
 *   about whether it is alive, and its owner id is findable wherever it stands.
 * - An **object** is tracked by its authored cell: it cannot walk away, so
 *   "gone from this cell" is the whole test. One carried off and dropped
 *   elsewhere reads as gone and grows back — the Tibia bargain, taken
 *   knowingly: the map is the author's statement of what belongs there.
 */
export type SpawnPoint = {
  /**
   * Stable identity for this point: the owner id for a creature, cell-and-tile
   * for an object. What deadlines are filed under, so it must survive the
   * round trip through Durable Object storage.
   */
  key: string;
  cell: Coord;
  /** How long an emptied point waits, copied off the def at derivation. */
  respawn: RespawnInteraction;
  /**
   * The placement to grow back, as authored: direction, channel, sign and
   * contents survive, while runtime identities (`owner`, `itemId`, content
   * ids) are stripped — a respawned sword is a new sword, and handing it the
   * old id would put two things in the world answering to one name.
   */
  placed: PlacedTile;
  /** Creatures only: who the respawned body is adopted as. */
  ownerId?: string;
  /**
   * Objects only: how many identical placements the author put in this cell.
   * The filled test tops the count up rather than asking yes/no, so two
   * authored coins in one cell owe two back.
   */
  count?: number;
};

/** A wait drawn from the authored range, both ends included. */
export function rollRespawnDelayMs(
  respawn: RespawnInteraction,
  random: () => number = Math.random,
): number {
  const spread = respawn.toMs - respawn.fromMs + 1;
  return respawn.fromMs + Math.floor(random() * spread);
}

/**
 * An instance ready to be re-minted: `mintItemIds` only stamps instances with
 * no id, so the stripped copy is what makes a respawned chest's sword a fresh
 * sword rather than a second copy of the one somebody already carried off.
 * Contents are flat — a container never holds a container — so there is
 * nothing to recurse into, and the cast only hides the id `mintItemIds` is
 * about to supply.
 */
function remintable(instance: ItemInstance): ItemInstance {
  const { id: _id, ...rest } = instance;
  return rest as ItemInstance;
}

/** The authored placement with every runtime identity stripped. */
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

/**
 * Every spawn point in `map`, which must be a map every point is *filled* in —
 * the one a fresh world opens with, after residents have been adopted (their
 * owner ids are read off the placements rather than re-derived, so the two can
 * never disagree). Run against a resumed checkpoint this would silently drop
 * every point whose creature died before the eviction, which is why the server
 * derives once and stores the result.
 */
export function findSpawnPoints(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): SpawnPoint[] {
  const points = new Map<string, SpawnPoint>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const cell = { x, y, z };
      stack.forEach((placed, stackIndex) => {
        const def = tilesById[placed.tileId];
        const respawn = def ? resolveRespawn(def) : null;
        if (!def || !respawn) return;

        if (resolveActor(def)) {
          const ownerId =
            placed.owner ?? residentOwnerId({ ...cell, stackIndex });
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
        } else {
          points.set(key, {
            key,
            cell,
            respawn,
            placed: authoredPlacement(placed),
            count: 1,
          });
        }
      });
    }
  }
  return [...points.values()];
}

/**
 * Is this point's tenant present — nothing owed?
 *
 * A creature counts wherever it stands; an object counts only in its authored
 * cell, up to the authored number. The creature test is a whole-map sweep, so
 * callers keep it off the hot path: the server asks on a death, on a changed
 * cell, and once at load — never per tick per point.
 */
export function isSpawnFilled(map: MapFile, point: SpawnPoint): boolean {
  if (point.ownerId) {
    return findActorAnywhere(map, point.ownerId) !== null;
  }
  const present = getStack(map, point.cell.x, point.cell.y, point.cell.z).filter(
    (placed) => placed.tileId === point.placed.tileId,
  ).length;
  return present >= (point.count ?? 1);
}

