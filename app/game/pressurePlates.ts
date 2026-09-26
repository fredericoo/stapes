import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { PressurePlateInteraction } from "../lib/interactions";
import { plateTriggers, resolvePressurePlate } from "../lib/interactions";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, coordKey, physicalHeight } from "../lib/types";
import { canReplaceStack } from "../lib/validation";

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
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
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
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  let next = stack;
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
