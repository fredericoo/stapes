import { getStack, listCoords } from "../lib/mapData";
import { MAX_LEVEL, MIN_LEVEL, type Coord, type MapFile } from "../lib/types";

/**
 * Where each kind of tile is standing, so "the nearest oak" is a lookup rather
 * than a sweep.
 *
 * The same index discipline `plateCells` and `wiredCells` already use, and for
 * the same reason: a brain asks its questions every brain tick, and a whole-map
 * scan at that rate is the most expensive thing in the loop. Nothing here is
 * authored — membership is read off what is actually placed, so a tile invented
 * tomorrow is findable the moment somebody puts one down, with no list to keep.
 *
 * Keyed by tile id and then by cell, because both of the things this is asked
 * are lookups: "where are the oaks" to answer a selector, and "forget this cell"
 * when a stack changes under it.
 */
export type TileCellIndex = Map<string, Map<string, Coord>>;

/** The key a cell goes under. Matches the session's own `cellKey`. */
export function tileCellKey(cell: Coord): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

/**
 * Every cell holding each tile. Whole-map scan — for building an index once, not
 * for running per tick.
 */
export function indexTileCells(map: MapFile): TileCellIndex {
  const index: TileCellIndex = new Map();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      for (const placed of stack) {
        addTileCell(index, placed.tileId, { x, y, z });
      }
    }
  }
  return index;
}

function addTileCell(index: TileCellIndex, tileId: string, cell: Coord) {
  const cells = index.get(tileId);
  if (cells) {
    cells.set(tileCellKey(cell), cell);
    return;
  }
  index.set(tileId, new Map([[tileCellKey(cell), cell]]));
}

/**
 * Re-read one cell into the index, dropping whatever it used to hold.
 *
 * The drop is a pass over every tile id rather than a reverse lookup kept beside
 * this one. A library is tens of tiles and a stack change touches one cell, so
 * the pass costs less than a second index would cost to keep honest — and a
 * second index that drifted would strand a tile in a bucket it had left.
 */
export function reindexTileCell(index: TileCellIndex, map: MapFile, cell: Coord) {
  const key = tileCellKey(cell);
  for (const cells of index.values()) cells.delete(key);
  for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
    addTileCell(index, placed.tileId, cell);
  }
}

/** How a cell full of scenery names itself when a selector picks it out. */
const CELL_REF_PREFIX = "cell:";

/**
 * The id a static tile answers to.
 *
 * Selectors resolve to an id, which the blackboard then remembers — that is what
 * lets a creature commit to one quarry across several states. Scenery has no
 * actor to lend an id, so its cell becomes one: a tree does not move, so where it
 * is *is* which one it is.
 *
 * The tile is named inside the ref rather than the cell alone, so a felled oak
 * answers nobody instead of leaving a creature walking towards a stump. That
 * makes a vanished target read as out of range, which is exactly how a target
 * that left the world already reads.
 */
export function cellRefId(tileId: string, cell: Coord): string {
  return `${CELL_REF_PREFIX}${tileId}@${cell.x},${cell.y},${cell.z}`;
}

/** The cell a ref points at, or null when this is an actor id rather than a ref. */
export function parseCellRef(
  id: string,
): { tileId: string; cell: Coord } | null {
  if (!id.startsWith(CELL_REF_PREFIX)) return null;
  const [tileId, coords] = id.slice(CELL_REF_PREFIX.length).split("@");
  if (!tileId || !coords) return null;
  const parts = coords.split(",").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, z] = parts as [number, number, number];
  return { tileId, cell: { x, y, z } };
}

/** Is that tile still standing there? @see cellRefId */
export function cellRefStillHolds(
  map: MapFile,
  ref: { tileId: string; cell: Coord },
): boolean {
  return getStack(map, ref.cell.x, ref.cell.y, ref.cell.z).some(
    (placed) => placed.tileId === ref.tileId,
  );
}
