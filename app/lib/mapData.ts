import type { ItemInstance } from "./itemInstance";
import type {
  ChunkCells,
  Coord,
  Direction,
  FlatMapFile,
  LevelChunks,
  MapFile,
  PlacedTile,
  TileDef,
} from "./types";
import {
  CHUNK_SIZE,
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
  physicalHeight,
  resolveIntangible,
  resolveWalkable,
} from "./types";

export function emptyMap(): MapFile {
  return { version: 1, levels: {} };
}

export function getStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): PlacedTile[] {
  return map.levels[levelKey(z)]?.[chunkKeyFor(x, y)]?.[coordKey(x, y)] ?? [];
}

/** Chunk a cell belongs to. Hot enough to inline the arithmetic. */
export function chunkKeyFor(x: number, y: number): string {
  return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`;
}

/** Key of the chunk at chunk-space coordinates — for addressing a rect's chunks. */
export function chunkKeyAt(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** Chunk-space index containing cell coordinate `v` on either axis. */
export function chunkIndexOf(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

/**
 * Cell keys whose stack differs between two versions of a level.
 *
 * Leans entirely on copy-on-write: an edit rewrites the one chunk it touched
 * and leaves every other chunk identical, so a reference compare skips
 * thousands of cells before a single key is read. A walk comes out of this as
 * exactly two cells on a 4565-cell floor.
 *
 * Callers use it to answer "is it worth rebuilding everything?" — so it returns
 * the cells rather than a boolean, and stays silent about what changed in them.
 */
export function changedCellsOnLevel(
  prev: MapFile,
  next: MapFile,
  z: number,
): Set<string> {
  const out = new Set<string>();
  const before = prev.levels[levelKey(z)];
  const after = next.levels[levelKey(z)];
  if (before === after) return out;

  const chunkKeys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const chk of chunkKeys) {
    const a = before?.[chk];
    const b = after?.[chk];
    if (a === b) continue;
    for (const key in b) {
      if (a?.[key] !== b[key]) out.add(key);
    }
    for (const key in a) {
      if (b?.[key] === undefined) out.add(key);
    }
  }
  return out;
}

/**
 * One chunk's worth of difference between two versions of a map.
 *
 * `cells` is the chunk as it stands *now*, and is empty for a chunk that has
 * gone — the caller is persistence, and "there is nothing here any more" is
 * something it has to be able to write down rather than merely omit.
 */
export type ChangedChunk = {
  levelKey: string;
  chunkKey: string;
  cells: ChunkCells;
};

/**
 * Chunks whose contents differ between two versions of a map.
 *
 * The chunk-granular sibling of {@link changedCellsOnLevel}, leaning on the
 * same copy-on-write identity: a walk rewrites the one chunk it crossed and
 * leaves every other chunk the same object, so diffing a busy world is a
 * handful of reference compares. Where that function answers "what moved", this
 * one answers "what is worth writing down", which is why it stops at the chunk
 * rather than descending into cells.
 *
 * A `prev` of null means nothing is known about the previous state and every
 * chunk comes back — the shape a caller wants after loading, or after the world
 * has been replaced wholesale.
 */
export function changedChunks(
  prev: MapFile | null,
  next: MapFile,
): ChangedChunk[] {
  const out: ChangedChunk[] = [];
  const levelKeys = new Set([
    ...Object.keys(prev?.levels ?? {}),
    ...Object.keys(next.levels),
  ]);
  for (const zk of levelKeys) {
    const before = prev?.levels[zk];
    const after = next.levels[zk];
    if (before === after) continue;
    const chunkKeys = new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after ?? {}),
    ]);
    for (const chk of chunkKeys) {
      const a = before?.[chk];
      const b = after?.[chk];
      if (a === b) continue;
      out.push({ levelKey: zk, chunkKey: chk, cells: b ?? {} });
    }
  }
  return out;
}

/**
 * Assemble a map from chunks that were stored one by one.
 *
 * The inverse of {@link changedChunks} — the levels come back grouped exactly as
 * a running map holds them, so nothing has to be re-chunked on the way in.
 * Empty chunks are dropped: they are the tombstones {@link changedChunks} emits
 * for a chunk that has gone, and there is nothing in them to restore.
 */
export function mapFromChunks(chunks: Iterable<ChangedChunk>): MapFile {
  const levels: Record<string, LevelChunks> = {};
  for (const { levelKey: zk, chunkKey: chk, cells } of chunks) {
    if (isEmptyRecord(cells)) continue;
    (levels[zk] ??= {})[chk] = cells;
  }
  return { version: 1, levels };
}

/** Cells of one chunk, or an empty record. */
export function getChunk(
  map: MapFile,
  z: number,
  chunk: string,
): ChunkCells | undefined {
  return map.levels[levelKey(z)]?.[chunk];
}

/** Every chunk key present on a level. */
export function listChunkKeys(map: MapFile, z: number): string[] {
  const level = map.levels[levelKey(z)];
  return level ? Object.keys(level) : [];
}

export function stackHeight(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number {
  let h = 0;
  for (const p of stack) {
    const def = tilesById[p.tileId];
    if (def) h += physicalHeight(def);
  }
  return h;
}

/** Elevation under the tile at stackIndex (sum of physical heights below it). */
export function elevationAt(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  let e = 0;
  for (let i = 0; i < stackIndex; i++) {
    const def = tilesById[stack[i]!.tileId];
    if (def) e += physicalHeight(def);
  }
  return e;
}

/**
 * Topmost non-intangible tile in a stack. Intangibles don't form a solid
 * surface — walk/land checks look through them to the tile underneath.
 */
export function solidTopOfStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const placed = stack[i]!;
    const def = tilesById[placed.tileId];
    if (def && resolveIntangible(def)) continue;
    return placed;
  }
  return null;
}

/**
 * Absolute standing elevation for a stack surface:
 * `z * HEIGHT_PER_LEVEL + stackHeight(stack)`.
 */
export function absoluteStandingElevation(
  z: number,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number {
  return z * HEIGHT_PER_LEVEL + stackHeight(stack, tilesById);
}

/**
 * Elevation (within the level) of the highest walkable tile top in `stack`.
 * Null when no walkable tile is present.
 */
export function walkableElevInStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  let elev = 0;
  let best: number | null = null;
  for (const p of stack) {
    const def = tilesById[p.tileId];
    if (!def) continue;
    elev += physicalHeight(def);
    // Intangible walkable tops don't form a standing plane — pass through.
    if (resolveWalkable(def) && !resolveIntangible(def)) best = elev;
  }
  return best;
}

/** Absolute walkable standing elevation for a stack, or null. */
export function absoluteWalkableElevation(
  z: number,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  const elev = walkableElevInStack(stack, tilesById);
  if (elev == null) return null;
  return z * HEIGHT_PER_LEVEL + elev;
}

/**
 * When `below` at `zBelow` is an exactly-full level whose walkable top seals
 * the level, returns the floor abs at the base of `zBelow + 1`.
 * Non-walkable fillers (e.g. a lone tree) do not form a floor.
 */
export function walkableFloorAbove(
  zBelow: number,
  below: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  if (stackHeight(below, tilesById) !== HEIGHT_PER_LEVEL) return null;
  const walkAbs = absoluteWalkableElevation(zBelow, below, tilesById);
  const floorAbs = (zBelow + 1) * HEIGHT_PER_LEVEL;
  if (walkAbs !== floorAbs) return null;
  return floorAbs;
}

/**
 * The walkable placed tile whose top is at `elevInLevel` within `stack`,
 * or null if none (e.g. floor-only surface).
 */
export function walkableTileAtElev(
  stack: PlacedTile[],
  elevInLevel: number,
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  let elev = 0;
  for (const p of stack) {
    const def = tilesById[p.tileId];
    if (!def) continue;
    elev += physicalHeight(def);
    if (
      resolveWalkable(def) &&
      !resolveIntangible(def) &&
      elev === elevInLevel
    ) {
      return p;
    }
  }
  return null;
}

/**
 * The placed tile forming the solid surface at absolute `abs`, or null when
 * nothing surfaces there. The first stack whose top lands on `abs` wins even
 * if it is not walkable — that tile still owns the plane, and callers that
 * care about standing on it check {@link resolveWalkable} themselves.
 * Intangible tops are skipped so pass-through tiles don't block standing.
 */
export function surfaceTileAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): PlacedTile | null {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = stack.filter((_, i) => i !== exclude.stackIndex);
    }
    if (stack.length === 0) continue;
    const top = absoluteStandingElevation(z, stack, tilesById);
    if (top !== abs) continue;
    const solid = solidTopOfStack(stack, tilesById);
    if (solid) return solid;
  }

  // Floor formed by a full walkable level below — its top tile is the surface.
  const zFloor = Math.floor(abs / HEIGHT_PER_LEVEL);
  if (abs === zFloor * HEIGHT_PER_LEVEL && zFloor > MIN_LEVEL) {
    let below = getStack(map, x, y, zFloor - 1);
    if (exclude && exclude.z === zFloor - 1) {
      below = below.filter((_, i) => i !== exclude.stackIndex);
    }
    if (walkableFloorAbove(zFloor - 1, below, tilesById) === abs) {
      return solidTopOfStack(below, tilesById);
    }
  }
  return null;
}

/** True when a solid stack top at absolute `abs` is walkable. */
export function isWalkableSurfaceAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): boolean {
  const placed = surfaceTileAt(map, x, y, abs, tilesById, exclude);
  if (!placed) return false;
  const def = tilesById[placed.tileId];
  return def ? resolveWalkable(def) : true;
}

/** Climb-from source underfoot at absolute standing elevation `fromAbs`. */
export function climbFromSourceAt(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): { def: TileDef; direction: Direction } | null {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    let stack = getStack(map, x, y, z);
    if (exclude && exclude.z === z) {
      stack = stack.filter((_, i) => i !== exclude.stackIndex);
    }
    const walkAbs = absoluteWalkableElevation(z, stack, tilesById);
    if (walkAbs !== fromAbs) continue;
    const elevIn = fromAbs - z * HEIGHT_PER_LEVEL;
    const placed = walkableTileAtElev(stack, elevIn, tilesById);
    if (!placed) continue;
    const def = tilesById[placed.tileId];
    if (!def) continue;
    return { def, direction: placed.direction ?? "s" };
  }
  return null;
}

/**
 * Copy-on-write path update: only the touched level and cell get new objects.
 * Untouched levels and cells keep their identity so the renderer can diff by
 * reference and rebuild only dirty chunks.
 *
 * Callers must pass a freshly built `stack` array — we do not clone it.
 */
/**
 * Only worth asking after a delete — and not cheap even then. `for...in` makes
 * V8 build an enumeration cache over the whole object, so on a populated level
 * this is O(cells), not the O(1) it looks like.
 */
function isEmptyRecord(record: Record<string, unknown>): boolean {
  for (const _ in record) return false;
  return true;
}

/** One cell's new contents. An empty `stack` clears the cell. */
export type StackEdit = {
  x: number;
  y: number;
  z: number;
  stack: PlacedTile[];
};

/**
 * Apply several cell edits, copying each affected level once.
 *
 * Callers that move a tile touch two cells, and doing that as two separate
 * writes copies the level twice — on a populated ground floor that is thousands
 * of keys copied to change two of them. Levels the edits do not touch keep
 * their identity, which is what downstream change detection reads.
 */
export function setStacks(map: MapFile, edits: readonly StackEdit[]): MapFile {
  if (!edits.length) return map;

  const levels = { ...map.levels };
  // Chunks copied so far, so several edits landing in one chunk share a copy.
  const copied = new Map<string, ChunkCells>();
  let deleted = false;

  for (const edit of edits) {
    const zk = levelKey(edit.z);
    const chk = chunkKeyFor(edit.x, edit.y);
    const path = `${zk}/${chk}`;

    let chunk = copied.get(path);
    if (!chunk) {
      const level = levels[zk];
      chunk = { ...(level?.[chk] ?? {}) };
      copied.set(path, chunk);
      levels[zk] = { ...(level ?? {}), [chk]: chunk };
    }

    const ck = coordKey(edit.x, edit.y);
    if (edit.stack.length === 0) {
      delete chunk[ck];
      deleted = true;
    } else {
      chunk[ck] = edit.stack;
    }
  }

  // Only a delete can empty anything, and emptiness checks are not free.
  if (deleted) pruneEmpty(levels, copied);
  return { version: 1, levels };
}

/** Drop chunks and levels an edit emptied, so identity means "has content". */
function pruneEmpty(
  levels: Record<string, LevelChunks>,
  copied: Map<string, ChunkCells>,
) {
  const touchedLevels = new Set<string>();
  for (const path of copied.keys()) {
    const [zk, chk] = path.split("/");
    touchedLevels.add(zk!);
    const level = levels[zk!];
    if (level && isEmptyRecord(level[chk!]!)) {
      const next = { ...level };
      delete next[chk!];
      levels[zk!] = next;
    }
  }
  for (const zk of touchedLevels) {
    if (isEmptyRecord(levels[zk]!)) delete levels[zk];
  }
}

function setStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
): MapFile {
  return setStacks(map, [{ x, y, z, stack }]);
}

export function clearStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
): MapFile {
  return setStack(map, x, y, z, []);
}

export function replaceStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
): MapFile {
  return setStack(map, x, y, z, stack);
}

export function appendTile(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  placed: PlacedTile,
): MapFile {
  const stack = [...getStack(map, x, y, z), placed];
  return setStack(map, x, y, z, stack);
}

export function removeTileAt(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
): MapFile {
  const stack = [...getStack(map, x, y, z)];
  if (stackIndex < 0 || stackIndex >= stack.length) return map;
  stack.splice(stackIndex, 1);
  return setStack(map, x, y, z, stack);
}

export function reorderStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  fromIndex: number,
  toIndex: number,
): MapFile {
  const stack = [...getStack(map, x, y, z)];
  if (
    fromIndex < 0 ||
    fromIndex >= stack.length ||
    toIndex < 0 ||
    toIndex >= stack.length ||
    fromIndex === toIndex
  ) {
    return map;
  }
  const [item] = stack.splice(fromIndex, 1);
  stack.splice(toIndex, 0, item!);
  return setStack(map, x, y, z, stack);
}

export function updatePlacedDirection(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  direction: PlacedTile["direction"],
): MapFile {
  const stack = getStack(map, x, y, z).map((p, i) =>
    i === stackIndex ? { ...p, direction } : { ...p },
  );
  return setStack(map, x, y, z, stack);
}

/**
 * Every signal channel named anywhere in the map, sorted.
 *
 * There is no channel registry — a channel exists because some placement says
 * so — which is exactly why the editor needs this: it is the only way to offer
 * the names already in play and let a second plate join a wire by picking
 * rather than by retyping it correctly.
 */
export function listChannels(map: MapFile): string[] {
  const seen = new Set<string>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { stack } of listCoords(map, z)) {
      for (const placed of stack) {
        if (placed.channel) seen.add(placed.channel);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Set (or clear, with an empty string) one free-text field on a placement.
 *
 * Cleared means *absent*, not empty: the map is hand-editable and lives in
 * version control, so an abandoned field should leave no line behind.
 *
 * **Returns the same map when nothing changes.** Both fields here are committed
 * on blur, which fires on every focus-out whether or not a character was typed
 * — so without this, tabbing through the panel minted a map identity, an undo
 * entry and a geometry diff per field touched. A mutation that changes nothing
 * must return the same object; see docs/notes.md.
 */
function updatePlacedText(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  key: "channel" | "description",
  value: string,
): MapFile {
  const current = getStack(map, x, y, z);
  const trimmed = value.trim();
  const next = trimmed || undefined;
  if (current[stackIndex]?.[key] === next) return map;

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { [key]: _dropped, ...rest } = p;
    return next ? { ...rest, [key]: next } : rest;
  });
  return setStack(map, x, y, z, stack);
}

/**
 * Set (or clear, with an empty string) the signal channel on one placement.
 * See {@link PlacedTile.channel}.
 */
export function updatePlacedChannel(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  channel: string,
): MapFile {
  return updatePlacedText(map, x, y, z, stackIndex, "channel", channel);
}

/**
 * Set (or clear, with an empty string) what this placement says when looked at.
 * See {@link PlacedTile.description}.
 */
export function updatePlacedDescription(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  description: string,
): MapFile {
  return updatePlacedText(map, x, y, z, stackIndex, "description", description);
}

/**
 * Set what one placement hands over, and under which tag. Empty clears both.
 *
 * The pair moves together and is never half-written, because half of it is
 * inert: a tagless reward could be taken for ever and an empty one offers a verb
 * that does nothing, so `resolveReward` refuses either. Clearing one from the
 * dialog therefore clears both rather than leaving a placement whose settings
 * look authored and whose chest does nothing.
 *
 * **Returns the same map when nothing changes**, on exactly the terms
 * {@link updatePlacedText} does, and for the same reason: this commits when a
 * dialog closes, which happens whether or not anything was typed.
 */
export function updatePlacedReward(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  tag: string,
  tileIds: readonly string[],
): MapFile {
  const current = getStack(map, x, y, z);
  const placed = current[stackIndex];
  if (!placed) return map;

  const trimmedTag = tag.trim();
  const kept = tileIds.filter((id) => id.trim());
  const live = trimmedTag !== "" && kept.length > 0;
  const nextTag = live ? trimmedTag : undefined;
  const nextIds = live ? kept : undefined;

  if (
    placed.rewardTag === nextTag &&
    sameIds(placed.rewardTileIds, nextIds)
  ) {
    return map;
  }

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { rewardTag: _tag, rewardTileIds: _ids, ...rest } = p;
    return live ? { ...rest, rewardTag: nextTag, rewardTileIds: nextIds } : rest;
  });
  return setStack(map, x, y, z, stack);
}

/**
 * Set where one placement sends people, or clear it.
 *
 * `null` clears, and clearing is how a portal is un-authored: the tile stays a
 * teleporter and the placement stops being one, which is exactly the split the
 * field exists for. There is no half-written state to guard against here — the
 * three numbers arrive together or not at all — so unlike
 * {@link updatePlacedReward} nothing has to be cleared in sympathy.
 *
 * **Returns the same map when nothing changes**, on exactly the terms
 * {@link updatePlacedText} does, and for the same reason: this commits when a
 * dialog closes, which happens whether or not anything was typed.
 */
export function updatePlacedTeleport(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  to: Coord | null,
): MapFile {
  const current = getStack(map, x, y, z);
  const placed = current[stackIndex];
  if (!placed) return map;

  if (sameCoord(placed.teleportTo, to ?? undefined)) return map;

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { teleportTo: _to, ...rest } = p;
    return to ? { ...rest, teleportTo: { ...to } } : rest;
  });
  return setStack(map, x, y, z, stack);
}

/** Two cells, either of which may be absent, naming the same spot. */
function sameCoord(a: Coord | undefined, b: Coord | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Two id lists, either of which may be absent, holding the same ids in order. */
function sameIds(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function coordToChunk(x: number, y: number): { cx: number; cy: number } {
  return {
    cx: Math.floor(x / CHUNK_SIZE),
    cy: Math.floor(y / CHUNK_SIZE),
  };
}

/** List all occupied coords on a level. */
export function listCoords(
  map: MapFile,
  z: number,
): Array<{ x: number; y: number; stack: PlacedTile[] }> {
  const level = map.levels[levelKey(z)];
  if (!level) return [];
  const out: Array<{ x: number; y: number; stack: PlacedTile[] }> = [];
  for (const chunk of Object.values(level)) {
    for (const [key, stack] of Object.entries(chunk)) {
      const { x, y } = parseCoordKey(key);
      out.push({ x, y, stack });
    }
  }
  return out;
}

/**
 * Group a flat on-disk level into chunks.
 *
 * The stored format stays flat: it is diffable, hand-editable, and chunk
 * boundaries are a runtime concern that should not leak into a file people read.
 */
export function chunkifyMap(flat: FlatMapFile): MapFile {
  const levels: Record<string, LevelChunks> = {};
  for (const [zk, cells] of Object.entries(flat.levels)) {
    const level: LevelChunks = {};
    for (const [ck, stack] of Object.entries(cells)) {
      if (!stack.length) continue;
      const { x, y } = parseCoordKey(ck);
      const chk = chunkKeyFor(x, y);
      (level[chk] ??= {})[ck] = stack;
    }
    if (!isEmptyRecord(level)) levels[zk] = level;
  }
  return { version: 1, levels };
}

/**
 * Flatten chunked levels back to the on-disk shape.
 *
 * Cells come out in a deterministic (x, then y) order rather than whatever
 * order the chunks happen to hold them. The file is version-controlled, and
 * without this every save would reshuffle thousands of lines and bury the one
 * cell that actually changed.
 */
export function flattenMap(map: MapFile): FlatMapFile {
  const levels: Record<string, Record<string, PlacedTile[]>> = {};
  for (const [zk, level] of Object.entries(map.levels)) {
    const entries: Array<[number, number, PlacedTile[]]> = [];
    for (const chunk of Object.values(level)) {
      for (const [ck, stack] of Object.entries(chunk)) {
        const { x, y } = parseCoordKey(ck);
        entries.push([x, y, stack]);
      }
    }
    if (!entries.length) continue;
    entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cells: Record<string, PlacedTile[]> = {};
    for (const [x, y, stack] of entries) cells[coordKey(x, y)] = stack;
    levels[zk] = cells;
  }
  return { version: 1, levels };
}

/**
 * A placement as it is *authored*, with the runtime's bookkeeping taken off.
 *
 * `extractsLeft` goes for the same reason one step along: how much of a vein is
 * left is a state of play, and a map saved after somebody spent an afternoon
 * mining would otherwise arrive claiming the author meant those bushes to be
 * half picked.
 *
 * `itemId` is minted when a world loads and is an identity for a thing while it
 * is being played with — not something anybody typed, and not something worth
 * carrying in a file people read diffs of. Picking a sword up, looting a chest
 * and dropping a bag all rewrite placements, so without this an editor save
 * after a few minutes of play would arrive full of ids nobody chose.
 *
 * Recursive into `contents` for the same reason: a chest is authored by what is
 * *in* it, and each of those gets a fresh identity on the next load.
 */
function authoredPlacement(placed: PlacedTile): PlacedTile {
  const { itemId: _itemId, extractsLeft: _extractsLeft, contents, ...rest } = placed;
  if (!contents) return rest;
  return {
    ...rest,
    contents: contents.map(({ id: _id, ...item }) => item as ItemInstance),
  };
}

/**
 * The map as a file, which is not quite the map as it is played.
 *
 * The one place the two shapes are allowed to differ, and the difference is
 * exactly the identities above. Everything that keeps them — the wire, the
 * checkpoint — uses {@link flattenMap} directly, because a running world very
 * much does need to know which sword is which.
 */
export function serializeMap(map: MapFile): string {
  const flat = flattenMap(map);
  const levels: FlatMapFile["levels"] = {};
  for (const [zk, cells] of Object.entries(flat.levels)) {
    const out: Record<string, PlacedTile[]> = {};
    for (const [ck, stack] of Object.entries(cells)) {
      out[ck] = stack.map(authoredPlacement);
    }
    levels[zk] = out;
  }
  return `${JSON.stringify({ ...flat, levels }, null, 2)}\n`;
}

export function parseMap(json: string): MapFile {
  const data = JSON.parse(json) as FlatMapFile;
  if (data.version !== 1) {
    throw new Error(`Unsupported map version: ${String(data.version)}`);
  }
  return chunkifyMap(data);
}
