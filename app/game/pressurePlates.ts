import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { PressurePlateInteraction } from "../lib/interactions";
import { plateTriggers, resolvePressurePlate } from "../lib/interactions";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, coordKey, physicalHeight } from "../lib/types";
import { canReplaceStack } from "../lib/validation";

/**
 * Identity of a cell across levels. {@link coordKey} alone repeats once per
 * level, and a plate index spans all of them.
 */
export function cellKey(cell: Coord): string {
  return `${cell.z}:${coordKey(cell.x, cell.y)}`;
}

/**
 * Total physical height resting on the tile at `stackIndex`.
 *
 * Only this stack counts. A plate reads what is standing *on* it, and the
 * stack is exactly the column of things it is holding up — a tile one level
 * higher in its own stack is being carried by whatever is between them, not by
 * the plate. Flat and intangible tiles weigh nothing, which is
 * {@link physicalHeight} rather than a rule of its own: a rug laid over a
 * plate is not a boot standing on it.
 */
export function loadAbove(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  let load = 0;
  for (let i = stackIndex + 1; i < stack.length; i++) {
    const def = tilesById[stack[i]!.tileId];
    if (def) load += physicalHeight(def);
  }
  return load;
}

/** Does any tile in this cell's stack behave as a pressure plate? */
export function cellHasPlate(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    const def = tilesById[placed.tileId];
    return def != null && resolvePressurePlate(def) != null;
  });
}

/**
 * Every cell holding a plate. Whole-map scan — for building an index once, not
 * for running per tick; maps hold thousands of cells and a handful of plates.
 */
export function findPlateCells(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasPlate(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

/**
 * `stack` with the plate at `i` swapped for its target, or null when it does
 * not trigger. A swap that would not fit the stack is refused rather than
 * forced: a plate whose pressed form is taller must not clip whatever is
 * standing on it — the very thing that pressed it.
 */
function swapPlateAt(
  map: MapFile,
  cell: Coord,
  stack: PlacedTile[],
  i: number,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const placed = stack[i];
  const def = placed ? tilesById[placed.tileId] : undefined;
  const plate: PressurePlateInteraction | null = def
    ? resolvePressurePlate(def)
    : null;
  if (!plate || !tilesById[plate.tileId]) return null;
  if (!plateTriggers(plate, loadAbove(stack, i, tilesById))) return null;

  const next = stack.map((p, j) => (j === i ? { ...p, tileId: plate.tileId } : p));
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok
    ? next
    : null;
}

/** The stack this cell settles to, or null when no plate in it triggers. */
function settledStack(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  let next = stack;
  // Bottom-up, so a plate stacked on a plate reads the load its neighbour has
  // already settled into rather than the one it had a moment ago.
  for (let i = 0; i < stack.length; i++) {
    const swapped = swapPlateAt(map, cell, next, i, tilesById);
    if (swapped) next = swapped;
  }
  return next === stack ? null : next;
}

export type SettleResult = {
  map: MapFile;
  /** Cells whose stack changed — their plate index entries are now suspect. */
  changed: Coord[];
};

/**
 * One settle pass over `cells`. Deliberately a single pass: a pair of plates
 * authored to trigger each other oscillates at tick rate instead of spinning
 * the frame, and a genuine cascade resolves over the ticks that follow.
 */
export function settlePlates(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
): SettleResult {
  const changed: Coord[] = [];
  let next = map;
  for (const cell of cells) {
    const stack = settledStack(next, cell, tilesById);
    if (!stack) continue;
    next = replaceStack(next, cell.x, cell.y, cell.z, stack);
    changed.push(cell);
  }
  return { map: next, changed };
}
