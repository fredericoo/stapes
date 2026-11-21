import { getStack, listCoords, presentLevels, replaceStack } from "../lib/mapData";
import type { PressurePlateInteraction } from "../lib/interactions";
import { plateTriggers, resolvePressurePlate } from "../lib/interactions";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { coordKey, physicalHeight } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { ChunkedCells } from "./chunkedCells";

export function cellKey(cell: Coord): string {
  return `${cell.z}:${coordKey(cell.x, cell.y)}`;
}

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

export function findPlateCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  const out: Coord[] = [];
  for (const z of presentLevels(map)) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasPlate(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

function swapPlateAt(
  map: MapFile,
  cell: Coord,
  stack: PlacedTile[],
  i: number,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const placed = stack[i];
  const def = placed ? tilesById[placed.tileId] : undefined;
  const plate: PressurePlateInteraction | null = def ? resolvePressurePlate(def) : null;
  if (!plate || !tilesById[plate.tileId]) return null;
  if (!plateTriggers(plate, loadAbove(stack, i, tilesById))) return null;

  const next = stack.map((p, j) => (j === i ? { ...p, tileId: plate.tileId } : p));
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok ? next : null;
}

function settledStack(
  map: MapFile,
  cell: Coord,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  let next = stack;
  /**
   * Bottom-up, so a plate stacked on a plate reads the load its neighbour has
   * already settled into rather than the one it had a moment ago.
   */
  for (let i = 0; i < stack.length; i++) {
    const swapped = swapPlateAt(map, cell, next, i, tilesById);
    if (swapped) next = swapped;
  }
  return next === stack ? null : next;
}

export type SettleResult = {
  map: MapFile;
  changed: Coord[];
};

/**
 * The stacks a plate cell held the last time it settled to no change. A swap
 * reads its own stack for the load and, through `canReplaceStack`, the stacks
 * on the levels above and below it, so while all three are the same arrays
 * the plate would settle to no change again.
 */
type QuietStacks = { stack: PlacedTile[]; below: PlacedTile[]; above: PlacedTile[] };

export type PlateCell = { cell: Coord; quiet: QuietStacks | null };

export function plateCell(cell: Coord): PlateCell {
  return { cell, quiet: null };
}

/** A plate's swap reads the stacks one level above and below it, through `canReplaceStack`. */
export function plateIndex(): ChunkedCells<PlateCell> {
  return new ChunkedCells(1, 1, plateCell);
}

/** `getStack` hands back a new empty array for every cell that holds nothing. */
function sameStack(a: PlacedTile[], b: PlacedTile[]): boolean {
  return a === b || (a.length === 0 && b.length === 0);
}

/**
 * A plate that swapped is left without `quiet`, so the next pass reads it
 * again even if nothing else touched it: that is what keeps a self-triggering
 * pair flipping once per pass.
 */
export function settlePlates(
  map: MapFile,
  plates: Iterable<PlateCell>,
  tilesById: Record<string, TileDef>,
): SettleResult {
  const changed: Coord[] = [];
  let next = map;
  for (const plate of plates) {
    const { x, y, z } = plate.cell;
    const stack = getStack(next, x, y, z);
    const below = getStack(next, x, y, z - 1);
    const above = getStack(next, x, y, z + 1);
    const quiet = plate.quiet;
    if (
      quiet &&
      quiet.stack === stack &&
      sameStack(quiet.below, below) &&
      sameStack(quiet.above, above)
    ) {
      continue;
    }
    const settled = settledStack(next, plate.cell, stack, tilesById);
    if (!settled) {
      plate.quiet = { stack, below, above };
      continue;
    }
    plate.quiet = null;
    next = replaceStack(next, x, y, z, settled);
    changed.push(plate.cell);
  }
  return { map: next, changed };
}
