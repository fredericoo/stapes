import type { MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  physicalHeight,
} from "./types";
import {
  elevationAfter,
  elevationAt,
  getStack,
  isPlayerBody,
  landedPlacement,
  stackHeight,
} from "./mapData";

export type PlaceResult = { ok: true } | { ok: false; reason: string };

export type FitOpts = {
  throughPlayers?: boolean;
};

function playerBodyInVolume(
  stack: PlacedTile[],
  z: number,
  feetAbs: number,
  headAbs: number,
  tilesById: Record<string, TileDef>,
): boolean {
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i]!;
    if (!isPlayerBody(placed)) continue;
    const def = tilesById[placed.tileId];
    if (!def) continue;
    const lo = z * HEIGHT_PER_LEVEL + elevationAt(stack, i, tilesById);
    const hi = lo + physicalHeight(def);
    if (lo < headAbs && hi > feetAbs) return true;
  }
  return false;
}

const BODY_REACH_LEVELS = 1;

function playerBodyNearLevel(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  feetAbs: number,
  headAbs: number,
  tilesById: Record<string, TileDef>,
): boolean {
  for (let zAt = z - BODY_REACH_LEVELS; zAt <= z + BODY_REACH_LEVELS; zAt++) {
    if (zAt < MIN_LEVEL || zAt > MAX_LEVEL) continue;
    const stack = getStack(map, x, y, zAt);
    if (playerBodyInVolume(stack, zAt, feetAbs, headAbs, tilesById)) return true;
  }
  return false;
}

export function fitsTile(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  opts?: FitOpts,
): PlaceResult {
  if (z < MIN_LEVEL || z > MAX_LEVEL) {
    return { ok: false, reason: "Level out of range" };
  }

  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    const belowH = stackHeight(below, tilesById);
    if (belowH > HEIGHT_PER_LEVEL) {
      return {
        ok: false,
        reason: "Space occupied by overflow from the level below",
      };
    }
  }

  const stack = getStack(map, x, y, z);
  const e = stackHeight(stack, tilesById);
  const h = physicalHeight(tileDef);
  const total = e + h;

  if (h === 0) {
    return { ok: true };
  }

  if (
    !opts?.throughPlayers &&
    playerBodyNearLevel(
      map,
      x,
      y,
      z,
      z * HEIGHT_PER_LEVEL + e,
      z * HEIGHT_PER_LEVEL + total,
      tilesById,
    )
  ) {
    return { ok: false, reason: "Somebody is standing there" };
  }

  if (e >= HEIGHT_PER_LEVEL) {
    return {
      ok: false,
      reason: "Stack already reaches the next level; place there instead",
    };
  }

  if (total <= HEIGHT_PER_LEVEL) {
    return { ok: true };
  }

  if (total <= HEIGHT_PER_LEVEL * 2) {
    if (z >= MAX_LEVEL) {
      return { ok: false, reason: "Cannot overflow past the top level" };
    }
    if (levelHoldsScenery(map, x, y, z + 1)) {
      return {
        ok: false,
        reason: "Cannot overflow: level above is occupied",
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Stack would exceed ${HEIGHT_PER_LEVEL * 2} height units`,
  };
}

function levelHoldsScenery(map: MapFile, x: number, y: number, z: number): boolean {
  return getStack(map, x, y, z).some((placed) => !isPlayerBody(placed));
}

export function canPlace(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
): PlaceResult {
  return fitsTile(map, x, y, z, tileDef, tilesById);
}

export function footRange(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): { min: number; max: number } {
  const placed = stack[stackIndex];
  if (!placed) return { min: 0, max: -1 };
  const def = tilesById[placed.tileId];
  const min = elevationAt(
    stack.map((p, i) => (i === stackIndex ? landedPlacement(p) : p)),
    stackIndex,
    tilesById,
  );
  return { min, max: HEIGHT_PER_LEVEL - (def ? physicalHeight(def) : 0) };
}

export function fitsFoot(
  stack: PlacedTile[],
  stackIndex: number,
  foot: number,
  tilesById: Record<string, TileDef>,
): PlaceResult {
  const { min, max } = footRange(stack, stackIndex, tilesById);
  if (!Number.isInteger(foot)) {
    return { ok: false, reason: "A foot is a whole number of height units" };
  }
  if (foot < min) {
    return { ok: false, reason: "Nothing can sit below what holds it up" };
  }
  if (foot > max) {
    return { ok: false, reason: "Raised that far it would leave the level" };
  }
  return { ok: true };
}

export function fitsAtElevation(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  opts?: FitOpts,
): PlaceResult {
  return fitsHeightAtElevation(map, x, y, feetAbs, physicalHeight(tileDef), tilesById, opts);
}

export function fitsHeightAtElevation(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  height: number,
  tilesById: Record<string, TileDef>,
  opts?: FitOpts,
): PlaceResult {
  const headAbs = feetAbs + height;
  const maxAbs = (MAX_LEVEL + 1) * HEIGHT_PER_LEVEL + HEIGHT_PER_LEVEL;
  if (feetAbs < MIN_LEVEL * HEIGHT_PER_LEVEL || headAbs > maxAbs) {
    return { ok: false, reason: "Out of vertical range" };
  }

  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const stack = getStack(map, x, y, z);
    if (stack.length === 0) continue;

    if (!opts?.throughPlayers && playerBodyInVolume(stack, z, feetAbs, headAbs, tilesById)) {
      return { ok: false, reason: "Somebody is standing there" };
    }

    if (!stack.some((placed) => !isPlayerBody(placed))) continue;

    const h = stackHeight(stack, tilesById);
    const volLo = z * HEIGHT_PER_LEVEL;
    const volHi = volLo + h;

    if (h === 0) {
      if (feetAbs < volLo && headAbs > volLo) {
        return { ok: false, reason: "Blocked by floor/ceiling above" };
      }
      continue;
    }

    if (volLo < headAbs && volHi > feetAbs) {
      return { ok: false, reason: "Blocked by solid in standing space" };
    }
  }

  return { ok: true };
}

export function canReplaceStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  newStack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): PlaceResult {
  if (z < MIN_LEVEL || z > MAX_LEVEL) {
    return { ok: false, reason: "Level out of range" };
  }

  if (z > MIN_LEVEL) {
    const below = getStack(map, x, y, z - 1);
    const belowH = stackHeight(below, tilesById);
    if (belowH > HEIGHT_PER_LEVEL && newStack.length > 0) {
      return {
        ok: false,
        reason: "Space occupied by overflow from the level below",
      };
    }
  }

  if (newStack.length === 0) {
    return { ok: true };
  }

  let e = 0;
  let bodies = 0;
  for (const placed of newStack) {
    const def = tilesById[placed.tileId];
    const h = def ? physicalHeight(def) : 0;
    if (e >= HEIGHT_PER_LEVEL && h > 0) {
      return {
        ok: false,
        reason: "Stack already reaches the next level; place there instead",
      };
    }
    if (isPlayerBody(placed)) {
      bodies = Math.max(bodies, h);
      continue;
    }
    e = elevationAfter(e, placed, tilesById);
  }
  e += bodies;

  if (e <= HEIGHT_PER_LEVEL) {
    return { ok: true };
  }

  if (e <= HEIGHT_PER_LEVEL * 2) {
    if (z >= MAX_LEVEL) {
      return { ok: false, reason: "Cannot overflow past the top level" };
    }
    const above = getStack(map, x, y, z + 1);
    if (above.length > 0) {
      return {
        ok: false,
        reason: "Cannot overflow: level above is occupied",
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Stack would exceed ${HEIGHT_PER_LEVEL * 2} height units`,
  };
}

export function tilesByIdFromList(tiles: TileDef[]): Record<string, TileDef> {
  const out: Record<string, TileDef> = {};
  for (const t of tiles) out[t.id] = t;
  return out;
}

export { coordKey, levelKey };
