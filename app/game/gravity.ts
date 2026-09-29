import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isSolidPlacement,
  listCoords,
  replaceStack,
  stackHeight,
} from "../lib/mapData";
import { pourInto } from "../lib/piles";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { MAX_CLIMB_HEIGHT } from "./constants";
import { placeEntityOnSurface, removeEntity } from "./mapMutations";
import { findLandingAbs, standingAbs } from "./movement";

export function isSupported(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): boolean {
  const stack = getStack(map, x, y, z);
  for (let i = 0; i < stackIndex; i++) {
    if (isSolidPlacement(stack[i]!, tilesById)) return true;
  }

  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    if (stackHeight(below, tilesById) >= HEIGHT_PER_LEVEL) return true;
  }

  return false;
}

export type GravityPull =
  | { kind: "stand" }
  | { kind: "settle"; landingAbs: number }
  | { kind: "fall"; feetAbs: number; landingAbs: number };

export function gravityPullOn(
  map: MapFile,
  at: Coord & { stackIndex: number },
  def: TileDef,
  tilesById: Record<string, TileDef>,
): GravityPull {
  if (!def.affectedByGravity) return { kind: "stand" };
  if (isSupported(map, at.x, at.y, at.z, at.stackIndex, tilesById)) {
    return { kind: "stand" };
  }

  const feetAbs = standingAbs(map, at.x, at.y, at.z, at.stackIndex, tilesById);
  const landingAbs = findLandingAbs(map, at.x, at.y, feetAbs, tilesById, {
    z: at.z,
    stackIndex: at.stackIndex,
  });
  if (landingAbs == null || landingAbs >= feetAbs) return { kind: "stand" };

  if (feetAbs - landingAbs <= MAX_CLIMB_HEIGHT) {
    return { kind: "settle", landingAbs };
  }
  return { kind: "fall", feetAbs, landingAbs };
}

function isLooseGravityBody(
  placed: PlacedTile | undefined,
  tilesById: Record<string, TileDef>,
): boolean {
  if (!placed || placed.owner) return false;
  return tilesById[placed.tileId]?.affectedByGravity === true;
}

export function cellHasLooseGravity(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) =>
    isLooseGravityBody(placed, tilesById),
  );
}

export function findLooseGravityCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasLooseGravity(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

export type GravityResult = {
  map: MapFile;
  changed: Coord[];
};

function unsupportedGravityIndex(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): number | null {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  for (let i = 0; i < stack.length; i++) {
    if (!isLooseGravityBody(stack[i], tilesById)) continue;
    if (isSupported(map, cell.x, cell.y, cell.z, i, tilesById)) continue;
    return i;
  }
  return null;
}

export function settleGravity(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
): GravityResult {
  const changed: Coord[] = [];
  let next = map;

  for (const cell of cells) {
    const stackIndex = unsupportedGravityIndex(next, cell, tilesById);
    if (stackIndex == null) continue;
    const placed = getStack(next, cell.x, cell.y, cell.z)[stackIndex];

    const feetAbs = standingAbs(next, cell.x, cell.y, cell.z, stackIndex, tilesById);
    const landing = findLandingAbs(next, cell.x, cell.y, feetAbs, tilesById, {
      z: cell.z,
      stackIndex,
    });
    if (landing == null || landing >= feetAbs) continue;

    const body = { ...placed! };
    const { z: destZ } = cellForFeetAbs(landing);
    next = removeEntity(next, cell.x, cell.y, cell.z, stackIndex);

    const destStack = getStack(next, cell.x, cell.y, destZ);
    const poured = pourInto(destStack, body, tilesById);
    const destTop = absoluteStandingElevation(destZ, destStack, tilesById);
    next = poured
      ? replaceStack(next, cell.x, cell.y, destZ, poured)
      : destStack.length > 0 && destTop === landing
        ? placeEntityOnSurface(next, cell.x, cell.y, destZ, body, tilesById)
        : appendTile(next, cell.x, cell.y, destZ, body);

    changed.push({ ...cell });
    changed.push({ x: cell.x, y: cell.y, z: destZ });
  }

  return { map: next, changed };
}

export function cellForFeetAbs(feetAbs: number): { z: number; elevInLevel: number } {
  let z = Math.floor(feetAbs / HEIGHT_PER_LEVEL);
  let elev = feetAbs - z * HEIGHT_PER_LEVEL;
  if (z < MIN_LEVEL) {
    elev += (MIN_LEVEL - z) * HEIGHT_PER_LEVEL;
    z = MIN_LEVEL;
  }
  if (z > MAX_LEVEL) {
    elev += (z - MAX_LEVEL) * HEIGHT_PER_LEVEL;
    z = MAX_LEVEL;
  }
  return { z, elevInLevel: elev };
}
