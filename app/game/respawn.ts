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
 *
 * An object that is an *item* is tracked more finely still, by the identities
 * of the very things standing in the cell — see {@link SpawnPoint.itemIds}.
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
  /**
   * Items only: which *things* are standing in this cell on the point's behalf.
   *
   * The identities of the placements themselves, and this is what makes a berry
   * that goes stale different from one somebody took. A decay rewrites a
   * placement's tile id and keeps its `itemId` (see `decay.ts`), so a point
   * asking after the thing sees a tenant that merely changed, where one asking
   * after the tile sees an empty cell and grows a second berry beside the first.
   *
   * **Departures are forgotten, arrivals are not adopted.** The server prunes
   * this to what is present whenever the cell changes, and only a respawn ever
   * writes an id back in. That asymmetry is the whole rule: a point emptied
   * stays owed however the cell is filled afterwards, so putting the berry back
   * where you found it does not talk the world out of growing another.
   *
   * Absent — not empty — for an object that is not an item, which has no
   * identities to track and falls back to counting tiles. Empty means the
   * opposite: a point that tracks things and is holding none.
   */
  itemIds?: string[];
};

/**
 * What came of asking the world to grow a point back.
 *
 * "Done" is not "grew one": a point found already filled, and one whose tile
 * has left the catalogue, are equally done and the server stops owing them.
 * "Blocked" is "not now" — the placement no longer fits under whatever has been
 * stacked in its cell — and is retried rather than abandoned, because unlike a
 * decay that cannot happen, a monster that never comes back is a hole in the
 * world rather than a mess left un-tidied.
 *
 * `itemId` is the identity of what was actually placed, present only when
 * something grew and it was an item. It is the one thing the session knows and
 * the server cannot work out for itself: the cell may hold several placements
 * of the same tile, and which of them is the new one is not a question a stack
 * read can answer.
 */
export type RespawnOutcome =
  | { kind: "done"; itemId?: string }
  | { kind: "blocked" };

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
            // Read off the placement rather than minted here: this runs after
            // `mintItemIds`, so an authored item already has the identity it
            // will keep for the rest of the world's life. A map that has not
            // been minted yet — a test's, an editor's — yields none, and the
            // point falls back to counting tiles.
            ...(placed.itemId ? { itemIds: [placed.itemId] } : {}),
          });
        }
      });
    }
  }
  return [...points.values()];
}

/**
 * Which of the things this point is answerable for are still standing in its
 * cell — the survivors of {@link SpawnPoint.itemIds}, in stack order.
 *
 * Empty for a point that tracks no identities, which is why every caller checks
 * `itemIds` itself before reading anything into the answer: "none of mine are
 * here" and "I have none to look for" are the same array and opposite facts.
 */
export function presentItemIds(map: MapFile, point: SpawnPoint): string[] {
  const owed = new Set(point.itemIds ?? []);
  if (owed.size === 0) return [];
  return getStack(map, point.cell.x, point.cell.y, point.cell.z).flatMap(
    (placed) =>
      placed.itemId && owed.has(placed.itemId) ? [placed.itemId] : [],
  );
}

/**
 * Is this point's tenant present — nothing owed?
 *
 * A creature counts wherever it stands; an object counts only in its authored
 * cell, up to the authored number. The creature test is a whole-map sweep, so
 * callers keep it off the hot path: the server asks on a death, on a changed
 * cell, and once at load — never per tick per point.
 *
 * An item point asks after the *things* it grew rather than the tile they wear,
 * which is what lets a berry rot in place without the world quietly growing a
 * second one beside it. It also means a point cannot be talked out of a debt by
 * a lookalike: an identical berry dropped into the cell is not one of this
 * point's, and does not count.
 */
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

/**
 * A point stored before identities were tracked, taught what it is holding.
 *
 * By tile, because that is the only question a point with no ids can ask. A
 * world resumed with a berry *already* gone stale therefore backfills nothing
 * for it and grows one more before it settles — once, on the one load that
 * migrates, and never again.
 *
 * Leaves a point that already tracks identities alone, and one whose tile is
 * not an item without any: an empty list would claim it tracks things.
 */
export function withMigratedItemIds(
  map: MapFile,
  point: SpawnPoint,
): SpawnPoint {
  if (point.ownerId || point.itemIds) return point;
  const itemIds = getStack(
    map,
    point.cell.x,
    point.cell.y,
    point.cell.z,
  ).flatMap((placed) =>
    placed.tileId === point.placed.tileId && placed.itemId
      ? [placed.itemId]
      : [],
  );
  return itemIds.length > 0 ? { ...point, itemIds } : point;
}

