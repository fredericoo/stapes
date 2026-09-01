import type { MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  physicalHeight,
} from "./types";
import { elevationAt, getStack, isPlayerBody, stackHeight } from "./mapData";

export type PlaceResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether the thing being fitted may share a cell with somebody standing in it.
 *
 * The whole of "players walk through each other", and it is a flag here rather
 * than a property of the tile because it is a fact about the *pair*: one player
 * passes through another, and nothing else passes through anybody. A wolf you
 * could walk into is not a threat and a corridor nobody can hold is not a
 * corridor, so a creature is stopped by a body exactly as it always was — and so
 * is a shoved crate, a thrown item and an editor's brush.
 *
 * Off by default, which is the conservative half: a caller that has not thought
 * about it gets the rule the whole world had before this existed. The three that
 * pass it are the three ways a person arrives somewhere — a step
 * (`../game/movement`'s `canWalk`), a login (`../game/entry`) and a portal
 * (`../game/affordances`'s `teleportFits`).
 *
 * @see ../lib/mapData's `isPlayerBody`, which decides what counts as a body.
 */
export type FitOpts = {
  throughPlayers?: boolean;
};

/**
 * Is somebody standing in the volume `feetAbs`…`headAbs` of this stack?
 *
 * Asked of a stack rather than of a column so both callers can fold it into a
 * loop they were already running. A body's own feet come from
 * {@link elevationAt}, which skips other bodies — so two people sharing a cell
 * report the same volume rather than one of them reporting the other's head as
 * its floor.
 */
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

/**
 * How far either side of a level a body standing on another level can reach.
 *
 * One, and it is arithmetic rather than a guess: a body is at most
 * `HEIGHT_PER_LEVEL` tall and its feet are always inside the level it is stored
 * on, so it can overflow into the level above and no further. Scanning the
 * whole column instead would be a seventeen-level sweep on the busiest call in
 * the game — see docs/notes.md, "Never sweep the map to answer a local
 * question".
 */
const BODY_REACH_LEVELS = 1;

/** {@link playerBodyInVolume} over the levels a body could reach into `z`. */
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

/**
 * Can `tileDef` sit on top of the stack at (x,y,z)?
 * Generic fit check (not player-specific) — same rules as editor placement.
 *
 * - Height-0 tiles add no volume and may stack freely on a full or overflowing
 *   stack (floors / plates / decorations on a solid top).
 * - For h > 0: feet must be within this level (e < HEIGHT_PER_LEVEL). A full
 *   stack already reaches the next level; place there instead (clean floor).
 * - e + h <= HEIGHT_PER_LEVEL: always allowed
 * - HEIGHT_PER_LEVEL < e + h <= 2*HEIGHT_PER_LEVEL: only if (x,y,z+1) is empty
 *   and z < MAX_LEVEL (e.g. full-height on a half-height base)
 * - e + h > 2*HEIGHT_PER_LEVEL: rejected
 * - Also rejected if stack at (x,y,z-1) totals more than HEIGHT_PER_LEVEL
 */
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

  // Flat tiles don't grow the stack volume — always fine on a full top.
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

/**
 * Is there anything at all on this level of the column that is not a body?
 *
 * The occupancy test overflow asks, and it is emptiness rather than height
 * because an intangible tile is still something the author put there. Bodies are
 * the exception on the terms every other sum here excludes them: somebody
 * standing on the floor above is not a reason a tall thing cannot be built
 * underneath them.
 */
function levelHoldsScenery(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): boolean {
  return getStack(map, x, y, z).some((placed) => !isPlayerBody(placed));
}

/** Can we append `tileDef` onto the existing stack at (x,y,z)? */
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

/**
 * Can `tileDef` stand with feet at absolute elevation `feetAbs` in column (x,y)?
 * Uses volume clearance (works on top of overflowing stacks where {@link fitsTile}
 * would reject because the level above is “occupied” by overflow).
 *
 * Height-0 tiles act as a floor plate / ceiling at the level base.
 */
export function fitsAtElevation(
  map: MapFile,
  x: number,
  y: number,
  feetAbs: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  opts?: FitOpts,
): PlaceResult {
  return fitsHeightAtElevation(
    map,
    x,
    y,
    feetAbs,
    physicalHeight(tileDef),
    tilesById,
    opts,
  );
}

/**
 * {@link fitsAtElevation} for a volume rather than a tile.
 *
 * A shoved crate with something sitting on it travels as one rigid column, and
 * the question the destination has to answer is whether *all* of it clears —
 * asking tile by tile would let a two-high pair through a one-high gap because
 * neither half of it is too tall on its own. Nothing about the check depends on
 * which tiles make up the height, so the height is all it takes.
 */
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

    if (
      !opts?.throughPlayers &&
      playerBodyInVolume(stack, z, feetAbs, headAbs, tilesById)
    ) {
      return { ok: false, reason: "Somebody is standing there" };
    }

    // Nothing but bodies here, and a body is not a floor — see `isPlayerBody`.
    // Falling through to the h === 0 branch would read the empty sum they leave
    // behind as a floor plate and seal a level nobody built anything on.
    if (!stack.some((placed) => !isPlayerBody(placed))) continue;

    const h = stackHeight(stack, tilesById);
    const volLo = z * HEIGHT_PER_LEVEL;
    const volHi = volLo + h;

    if (h === 0) {
      // Floor plate: blocks entering this level from below.
      if (feetAbs < volLo && headAbs > volLo) {
        return { ok: false, reason: "Blocked by floor/ceiling above" };
      }
      continue;
    }

    // Standing exactly on top (volHi === feetAbs) does not intersect.
    if (volLo < headAbs && volHi > feetAbs) {
      return { ok: false, reason: "Blocked by solid in standing space" };
    }
  }

  return { ok: true };
}

/**
 * Can we replace the entire stack at (x,y,z) with `newStack`?
 * Validates the whole stack as if built from empty, plus overflow/below rules.
 */
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

  // Empty is always fine (and frees overflow for the level below).
  if (newStack.length === 0) {
    return { ok: true };
  }

  let e = 0;
  for (const placed of newStack) {
    const def = tilesById[placed.tileId];
    const h = def ? physicalHeight(def) : 0;
    // Height-0 / intangible tiles may sit on a full/overflow stack; only
    // volume-adding tiles must start below the next-level boundary.
    if (e >= HEIGHT_PER_LEVEL && h > 0) {
      return {
        ok: false,
        reason: "Stack already reaches the next level; place there instead",
      };
    }
    e += h;
  }

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

/** Debug helper: ensure empty stacks aren't stored. */
export function assertNoEmptyStacks(map: MapFile): void {
  for (const level of Object.values(map.levels)) {
    for (const chunk of Object.values(level)) {
      for (const [key, stack] of Object.entries(chunk)) {
        if (stack.length === 0) {
          throw new Error(`Empty stack stored at ${key}`);
        }
      }
    }
  }
}

export { coordKey, levelKey };
