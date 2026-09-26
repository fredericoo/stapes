import { PLAYER_TILE_ID } from "../game/constants";
import type { ItemInstance } from "./itemInstance";
import { sameInstance } from "./itemInstance";
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
  MAP_FILE_VERSION,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  parseCoordKey,
  physicalHeight,
  resolveActor,
  resolveIntangible,
  resolveWalkable,
} from "./types";

export function emptyMap(): MapFile {
  return { version: MAP_FILE_VERSION, levels: {} };
}

export function getStack(map: MapFile, x: number, y: number, z: number): PlacedTile[] {
  return map.levels[levelKey(z)]?.[chunkKeyFor(x, y)]?.[coordKey(x, y)] ?? [];
}

export function stackOnLevel(
  map: MapFile,
  z: number,
  chunkKey: string,
  cellKey: string,
): PlacedTile[] | undefined {
  return map.levels[levelKey(z)]?.[chunkKey]?.[cellKey];
}

const tileIdsByChunk = new WeakMap<ChunkCells, ReadonlySet<string>>();

export function tileIdsInChunk(chunk: ChunkCells): ReadonlySet<string> {
  const cached = tileIdsByChunk.get(chunk);
  if (cached) return cached;
  const found = new Set<string>();
  for (const key in chunk) for (const placed of chunk[key]!) found.add(placed.tileId);
  tileIdsByChunk.set(chunk, found);
  return found;
}

const chunkKeys = new Map<number, string>();
const CHUNK_KEY_SPAN = 0x8000;
const MAX_CHUNK_KEYS = 0x10000;

export function chunkKeyFor(x: number, y: number): string {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  if (
    cx >= -CHUNK_KEY_SPAN &&
    cx < CHUNK_KEY_SPAN &&
    cy >= -CHUNK_KEY_SPAN &&
    cy < CHUNK_KEY_SPAN
  ) {
    const packed = (cx + CHUNK_KEY_SPAN) * 2 * CHUNK_KEY_SPAN + (cy + CHUNK_KEY_SPAN);
    let key = chunkKeys.get(packed);
    if (key === undefined) {
      if (chunkKeys.size >= MAX_CHUNK_KEYS) chunkKeys.clear();
      key = `${cx},${cy}`;
      chunkKeys.set(packed, key);
    }
    return key;
  }
  return `${cx},${cy}`;
}

export function chunkKeyAt(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function chunkIndexOf(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

type Lineage = { parent: WeakRef<object>; keys: string[] };
const lineage = new WeakMap<object, Lineage>();

const MAX_LINEAGE_STEPS = 1024;

function keysWrittenSince(ancestor: object, record: object): string[] | null {
  const keys: string[] = [];
  let at = record;
  for (let steps = 0; steps < MAX_LINEAGE_STEPS; steps++) {
    const link = lineage.get(at);
    if (!link) return null;
    for (const key of link.keys) keys.push(key);
    const parent = link.parent.deref();
    if (parent === undefined) return null;
    if (parent === ancestor) return keys;
    at = parent;
  }
  return null;
}

export function chunkCopiedFrom(
  chunk: ChunkCells,
): { from: ChunkCells; keys: readonly string[] } | null {
  const link = lineage.get(chunk);
  if (!link) return null;
  const from = link.parent.deref() as ChunkCells | undefined;
  return from === undefined ? null : { from, keys: link.keys };
}

function addChangedCells(out: Set<string>, a: ChunkCells | undefined, b: ChunkCells | undefined) {
  if (a === b) return;
  const written = a && b ? keysWrittenSince(a, b) : null;
  if (written) {
    for (const key of written) if (a![key] !== b![key]) out.add(key);
    return;
  }
  for (const key in b) {
    if (a?.[key] !== b[key]) out.add(key);
  }
  for (const key in a) {
    if (b?.[key] === undefined) out.add(key);
  }
}

export function changedCellsOnLevel(prev: MapFile, next: MapFile, z: number): Set<string> {
  const out = new Set<string>();
  const before = prev.levels[levelKey(z)];
  const after = next.levels[levelKey(z)];
  if (before === after) return out;

  const chunks = before && after ? keysWrittenSince(before, after) : null;
  if (chunks) {
    for (const chk of chunks) addChangedCells(out, before![chk], after![chk]);
    return out;
  }
  for (const chk in after) addChangedCells(out, before?.[chk], after[chk]);
  for (const chk in before) {
    if (after?.[chk] === undefined) addChangedCells(out, before[chk], undefined);
  }
  return out;
}

export function changedCellsInChunk(
  prev: MapFile,
  next: MapFile,
  z: number,
  chunk: string,
): Set<string> {
  const out = new Set<string>();
  addChangedCells(out, prev.levels[levelKey(z)]?.[chunk], next.levels[levelKey(z)]?.[chunk]);
  return out;
}

export type ChangedChunk = {
  levelKey: string;
  chunkKey: string;
  cells: ChunkCells;
};

export function changedChunks(prev: MapFile | null, next: MapFile): ChangedChunk[] {
  const out: ChangedChunk[] = [];
  const levelKeys = new Set([...Object.keys(prev?.levels ?? {}), ...Object.keys(next.levels)]);
  for (const zk of levelKeys) {
    const before = prev?.levels[zk];
    const after = next.levels[zk];
    if (before === after) continue;
    const chunkKeys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const chk of chunkKeys) {
      const a = before?.[chk];
      const b = after?.[chk];
      if (a === b) continue;
      out.push({ levelKey: zk, chunkKey: chk, cells: b ?? {} });
    }
  }
  return out;
}

export function mapFromChunks(chunks: Iterable<ChangedChunk>): MapFile {
  const levels: Record<string, LevelChunks> = {};
  for (const { levelKey: zk, chunkKey: chk, cells } of chunks) {
    if (isEmptyRecord(cells)) continue;
    (levels[zk] ??= {})[chk] = cells;
  }
  return { version: MAP_FILE_VERSION, levels };
}

export function getChunk(map: MapFile, z: number, chunk: string): ChunkCells | undefined {
  return map.levels[levelKey(z)]?.[chunk];
}

export function listChunkKeys(map: MapFile, z: number): string[] {
  const level = map.levels[levelKey(z)];
  return level ? Object.keys(level) : [];
}

export function isPlayerBody(placed: PlacedTile): boolean {
  return placed.tileId === PLAYER_TILE_ID && placed.owner != null;
}

export function isBodyPlacement(placed: PlacedTile, tilesById: Record<string, TileDef>): boolean {
  const def = tilesById[placed.tileId];
  return isPlayerBody(placed) || (def !== undefined && resolveActor(def));
}

export function terrainHeight(placed: PlacedTile, tilesById: Record<string, TileDef>): number {
  if (isPlayerBody(placed)) return 0;
  const def = tilesById[placed.tileId];
  return def ? physicalHeight(def) : 0;
}

export function footElevation(elevBelow: number, placed: PlacedTile): number {
  return placed.foot == null ? elevBelow : Math.max(elevBelow, placed.foot);
}

export function elevationAfter(
  elevBelow: number,
  placed: PlacedTile,
  tilesById: Record<string, TileDef>,
): number {
  return footElevation(elevBelow, placed) + terrainHeight(placed, tilesById);
}

export function stackHeight(stack: PlacedTile[], tilesById: Record<string, TileDef>): number {
  let h = 0;
  for (const p of stack) h = elevationAfter(h, p, tilesById);
  return h;
}

export function elevationAt(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): number {
  let e = 0;
  for (let i = 0; i < stackIndex; i++) e = elevationAfter(e, stack[i]!, tilesById);
  const placed = stack[stackIndex];
  return placed ? footElevation(e, placed) : e;
}

export function isSolidPlacement(placed: PlacedTile, tilesById: Record<string, TileDef>): boolean {
  if (isPlayerBody(placed)) return false;
  const def = tilesById[placed.tileId];
  return !(def && resolveIntangible(def));
}

export function solidTopOfStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const placed = stack[i]!;
    if (isSolidPlacement(placed, tilesById)) return placed;
  }
  return null;
}

export function absoluteStandingElevation(
  z: number,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number {
  return z * HEIGHT_PER_LEVEL + stackHeight(stack, tilesById);
}

export function walkableElevInStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  const footing = footingOfStack(stack, tilesById);
  return footing?.walkable ? footing.elev : null;
}

export type Footing = {
  elev: number;
  walkable: boolean;
};

const reusedFooting: Footing = { elev: 0, walkable: false };

export function footingOfStack(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): Footing | null {
  let elev = 0;
  let found = false;
  for (const p of stack) {
    elev = elevationAfter(elev, p, tilesById);
    const def = tilesById[p.tileId];
    if (!def) continue;
    if (isBodyPlacement(p, tilesById)) continue;
    if (resolveIntangible(def)) continue;
    found = true;
    reusedFooting.elev = elev;
    reusedFooting.walkable = resolveWalkable(def);
  }
  return found ? reusedFooting : null;
}

export function absoluteWalkableElevation(
  z: number,
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | null {
  const elev = walkableElevInStack(stack, tilesById);
  if (elev == null) return null;
  return z * HEIGHT_PER_LEVEL + elev;
}

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

export function planeCoveredAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
): boolean {
  if (abs % HEIGHT_PER_LEVEL !== 0) return false;
  const z = abs / HEIGHT_PER_LEVEL;
  if (z < MIN_LEVEL || z > MAX_LEVEL) return false;
  return planeCoveredBy(footingOfStack(getStack(map, x, y, z), tilesById));
}

export function planeCoveredBy(footing: Footing | null): boolean {
  return footing != null && footing.elev === 0 && !footing.walkable;
}

export function walkableTileAtElev(
  stack: PlacedTile[],
  elevInLevel: number,
  tilesById: Record<string, TileDef>,
): PlacedTile | null {
  let elev = 0;
  for (const p of stack) {
    elev = elevationAfter(elev, p, tilesById);
    if (isPlayerBody(p)) continue;
    const def = tilesById[p.tileId];
    if (!def) continue;
    if (resolveWalkable(def) && !resolveIntangible(def) && elev === elevInLevel) {
      return p;
    }
  }
  return null;
}

export function surfaceTileAt(
  map: MapFile,
  x: number,
  y: number,
  abs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): PlacedTile | null {
  for (let z = MAX_LEVEL; z >= MIN_LEVEL; z--) {
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

export function climbFromSourceAt(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  tilesById: Record<string, TileDef>,
  exclude?: { z: number; stackIndex: number },
): { def: TileDef; direction: Direction } | null {
  for (let z = MAX_LEVEL; z >= MIN_LEVEL; z--) {
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
 * `for...in` makes V8 build an enumeration cache over the whole object, so
 * on a populated level this is O(cells), not the O(1) it looks like.
 */
function isEmptyRecord(record: Record<string, unknown>): boolean {
  for (const _ in record) return false;
  return true;
}

export type StackEdit = {
  x: number;
  y: number;
  z: number;
  stack: PlacedTile[];
};

export function setStacks(map: MapFile, edits: readonly StackEdit[]): MapFile {
  if (!edits.length) return map;

  const levels = { ...map.levels };
  const copiedLevels = new Map<string, LevelChunks>();
  const copied = new Map<string, ChunkCells>();
  const writtenInto = new Map<ChunkCells, string[]>();
  const inherited = new Map<ChunkCells, { ids: ReadonlySet<string>; written: PlacedTile[][] }>();
  let deleted = false;

  for (const edit of edits) {
    const zk = levelKey(edit.z);
    const chk = chunkKeyFor(edit.x, edit.y);
    const path = `${zk}/${chk}`;

    let chunk = copied.get(path);
    if (!chunk) {
      let level = copiedLevels.get(zk);
      if (!level) {
        const sourceLevel = levels[zk];
        level = { ...sourceLevel };
        copiedLevels.set(zk, level);
        levels[zk] = level;
        if (sourceLevel) lineage.set(level, { parent: new WeakRef(sourceLevel), keys: [] });
      }
      const source = level[chk];
      chunk = { ...source };
      copied.set(path, chunk);
      level[chk] = chunk;
      lineage.get(level)?.keys.push(chk);
      const keys: string[] = [];
      writtenInto.set(chunk, keys);
      if (source) lineage.set(chunk, { parent: new WeakRef(source), keys });
      const ids = source && tileIdsByChunk.get(source);
      if (ids) inherited.set(chunk, { ids, written: [] });
    }
    inherited.get(chunk)?.written.push(edit.stack);

    const ck = coordKey(edit.x, edit.y);
    writtenInto.get(chunk)!.push(ck);
    if (edit.stack.length === 0) {
      delete chunk[ck];
      deleted = true;
    } else {
      chunk[ck] = edit.stack;
    }
  }

  for (const [chunk, { ids, written }] of inherited) {
    let next: Set<string> | null = null;
    for (const stack of written) {
      for (const placed of stack) {
        if ((next ?? ids).has(placed.tileId)) continue;
        next ??= new Set(ids);
        next.add(placed.tileId);
      }
    }
    tileIdsByChunk.set(chunk, next ?? ids);
  }

  if (deleted) pruneEmpty(levels, copied);
  return { version: MAP_FILE_VERSION, levels };
}

function pruneEmpty(levels: Record<string, LevelChunks>, copied: Map<string, ChunkCells>) {
  const touchedLevels = new Set<string>();
  for (const path of copied.keys()) {
    const [zk, chk] = path.split("/");
    touchedLevels.add(zk!);
    const level = levels[zk!];
    if (level && isEmptyRecord(level[chk!]!)) delete level[chk!];
  }
  for (const zk of touchedLevels) {
    if (isEmptyRecord(levels[zk]!)) delete levels[zk];
  }
}

function setStack(map: MapFile, x: number, y: number, z: number, stack: PlacedTile[]): MapFile {
  return setStacks(map, [{ x, y, z, stack }]);
}

export function clearStack(map: MapFile, x: number, y: number, z: number): MapFile {
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

export function landedPlacement(placed: PlacedTile): PlacedTile {
  if (placed.foot == null) return placed;
  const { foot: _foot, ...rest } = placed;
  return rest;
}

export function appendTile(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  placed: PlacedTile,
): MapFile {
  const stack = [...getStack(map, x, y, z), landedPlacement(placed)];
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

export function updatePlacedVariant(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  variant: string,
): MapFile {
  return updatePlacedText(map, x, y, z, stackIndex, "variant", variant);
}

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

function updatePlacedText(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  key: "channel" | "description" | "engraved" | "inscription" | "variant",
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

export function updatePlacedInscription(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  inscription: string,
): MapFile {
  return updatePlacedText(map, x, y, z, stackIndex, "inscription", inscription);
}

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

export function updatePlacedEngraving(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  engraved: string,
): MapFile {
  return updatePlacedText(map, x, y, z, stackIndex, "engraved", engraved);
}

export function updatePlacedFoot(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  foot: number | null,
  tilesById: Record<string, TileDef>,
): MapFile {
  const current = getStack(map, x, y, z);
  const placed = current[stackIndex];
  if (!placed) return map;

  const resting = elevationAt(
    current.map((p, i) => (i === stackIndex ? landedPlacement(p) : p)),
    stackIndex,
    tilesById,
  );
  const next = foot != null && foot > resting ? foot : undefined;
  if (placed.foot === next) return map;

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { foot: _foot, ...rest } = p;
    return next != null ? { ...rest, foot: next } : rest;
  });
  return setStack(map, x, y, z, stack);
}

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

  if (placed.rewardTag === nextTag && sameIds(placed.rewardTileIds, nextIds)) {
    return map;
  }

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { rewardTag: _tag, rewardTileIds: _ids, ...rest } = p;
    return live ? { ...rest, rewardTag: nextTag, rewardTileIds: nextIds } : rest;
  });
  return setStack(map, x, y, z, stack);
}

export function updatePlacedContents(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  contents: readonly ItemInstance[],
): MapFile {
  const current = getStack(map, x, y, z);
  const placed = current[stackIndex];
  if (!placed) return map;

  const next = contents.length > 0 ? contents : undefined;
  if (sameContents(placed.contents, next)) return map;

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { contents: _contents, ...rest } = p;
    return next ? { ...rest, contents: [...next] } : rest;
  });
  return setStack(map, x, y, z, stack);
}

function sameContents(
  a: readonly ItemInstance[] | undefined,
  b: readonly ItemInstance[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return other != null && sameInstance(item, other);
  });
}

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

function sameCoord(a: Coord | undefined, b: Coord | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

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
  return { version: MAP_FILE_VERSION, levels };
}

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
  return { version: MAP_FILE_VERSION, levels };
}

function authoredPlacement(placed: PlacedTile): PlacedTile {
  const {
    itemId: _itemId,
    extractsLeft: _extractsLeft,
    extractsReserved: _extractsReserved,
    contents,
    ...rest
  } = placed;
  if (!contents) return rest;
  return {
    ...rest,
    contents: contents.map(({ id: _id, ...item }) => item as ItemInstance),
  };
}

export function serializeMap(map: MapFile): string {
  const flat = flattenMap(map);
  const levels = Object.entries(flat.levels).map(([zk, cells]) => {
    const rows = Object.entries(cells).map(
      ([ck, stack]) =>
        `      ${JSON.stringify(ck)}: ${JSON.stringify(stack.map(authoredPlacement))}`,
    );
    return `    ${JSON.stringify(zk)}: {\n${rows.join(",\n")}\n    }`;
  });
  const body = levels.length ? `{\n${levels.join(",\n")}\n  }` : "{}";
  return `{\n  "version": ${flat.version},\n  "levels": ${body}\n}\n`;
}

const INSCRIPTIONS_WERE_DESCRIPTIONS = 1;

function liftInscriptions(flat: FlatMapFile): FlatMapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const [zk, cells] of Object.entries(flat.levels)) {
    const out: Record<string, PlacedTile[]> = {};
    for (const [ck, stack] of Object.entries(cells)) {
      out[ck] = stack.map((placed) => ({
        ...lifted(placed),
        ...(placed.contents ? { contents: placed.contents.map(lifted) } : {}),
      }));
    }
    levels[zk] = out;
  }
  return { version: MAP_FILE_VERSION, levels };
}

function lifted<T extends { description?: string; inscription?: string }>(thing: T): T {
  if (!thing.description) return thing;
  const next = { ...thing, inscription: thing.description };
  delete next.description;
  return next;
}

export function parseMap(json: string): MapFile {
  const data = JSON.parse(json) as FlatMapFile;
  if ((data.version as number) === INSCRIPTIONS_WERE_DESCRIPTIONS) {
    return chunkifyMap(liftInscriptions(data));
  }
  if (data.version !== MAP_FILE_VERSION) {
    throw new Error(`Unsupported map version: ${String(data.version)}`);
  }
  return chunkifyMap(data);
}
