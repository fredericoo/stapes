import { PLAYER_TILE_ID } from "../game/constants";
import type { ItemInstance } from "./itemInstance";
import { sameInstance } from "./itemInstance";
import { StackPool, isPooledStack } from "./stackPool";
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
  MAX_STACK_HEIGHT,
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

/** The tile every cell of an unloaded chunk reads as; `GameSession` adds its definition. */
export const UNLOADED_TILE_ID = "~unloaded";

/**
 * The record that stands in a level for a chunk whose cells are in the store
 * and not in memory. It has no keys, so a sweep of the board skips it, and
 * `getStack` answers every cell in it with a wall, so nothing walks, lands,
 * spreads or looks into it.
 */
export const UNLOADED_CHUNK: ChunkCells = Object.freeze({}) as ChunkCells;

const UNLOADED_STACK: PlacedTile[] = Object.freeze([
  Object.freeze({ tileId: UNLOADED_TILE_ID }),
]) as PlacedTile[];

export function isUnloadedAt(map: MapFile, x: number, y: number, z: number): boolean {
  return map.levels[levelKey(z)]?.[chunkKeyFor(x, y)] === UNLOADED_CHUNK;
}

/**
 * The unloaded chunks of a board sit on one frozen record that every level has
 * as its prototype, so a level's own keys are its loaded chunks and copying a
 * level for an edit costs only those. A read or a `for...in` still finds every
 * unloaded chunk; `Object.keys` and a spread do not, so a level is copied with
 * `copyLevel`.
 */
function awayOf(level: LevelChunks | undefined): LevelChunks | null {
  if (!level) return null;
  const proto = Object.getPrototypeOf(level) as LevelChunks | null;
  return proto === Object.prototype || proto === null ? null : proto;
}

function awayRecord(keys: Iterable<string>): LevelChunks | null {
  const record: LevelChunks = {};
  let any = false;
  for (const chk of keys) {
    record[chk] = UNLOADED_CHUNK;
    any = true;
  }
  return any ? Object.freeze(record) : null;
}

function levelOver(away: LevelChunks | null, own: LevelChunks): LevelChunks {
  return away ? Object.assign(Object.create(away) as LevelChunks, own) : { ...own };
}

export function copyLevel(level: LevelChunks): LevelChunks {
  return levelOver(awayOf(level), level);
}

/** `levels` holds only loaded chunks; every level is given `away` as unloaded. */
export function boardWithAway(levels: MapFile["levels"], away: Iterable<string>): MapFile {
  const record = awayRecord(away);
  const out: MapFile["levels"] = {};
  for (const zk in levels) out[zk] = levelOver(record, levels[zk]!);
  return { version: MAP_FILE_VERSION, levels: out };
}

/** Every chunk key that some level holds as `UNLOADED_CHUNK`. */
export function unloadedChunkKeys(map: MapFile): Set<string> {
  const out = new Set<string>();
  const seen = new Set<LevelChunks>();
  for (const zk in map.levels) {
    const level = map.levels[zk]!;
    const away = awayOf(level);
    if (away && !seen.has(away)) {
      seen.add(away);
      for (const chk of Object.keys(away)) out.add(chk);
    }
    for (const chk of Object.keys(level)) if (level[chk] === UNLOADED_CHUNK) out.add(chk);
  }
  return out;
}

/**
 * Puts `UNLOADED_CHUNK` in every present level for each key, including levels
 * where the chunk held nothing, so a creature that flies cannot rise over the
 * wall into air the chunk does not hold.
 */
export function unloadChunks(map: MapFile, chunkKeys: Iterable<string>): MapFile {
  const keys = new Set(chunkKeys);
  if (keys.size === 0) return map;
  const away = awayRecord([...unloadedChunkKeys(map), ...keys]);
  const levels: MapFile["levels"] = {};
  for (const zk in map.levels) {
    const source = map.levels[zk]!;
    const own: LevelChunks = {};
    for (const chk of Object.keys(source)) {
      if (!keys.has(chk) && source[chk] !== UNLOADED_CHUNK) own[chk] = source[chk]!;
    }
    const level = levelOver(away, own);
    lineage.set(level, { parent: new WeakRef(source), keys: [...keys] });
    levels[zk] = level;
  }
  return { version: MAP_FILE_VERSION, levels };
}

/**
 * Replaces `UNLOADED_CHUNK` with the stored records, each chunk's by level
 * key. A level with no stored record for a chunk holds nothing there. A level
 * that holds a real record for it already keeps that one.
 */
export function loadChunks(
  map: MapFile,
  stored: ReadonlyMap<string, ReadonlyMap<string, ChunkCells>>,
): MapFile {
  const before = unloadedChunkKeys(map);
  const coming = [...stored.keys()].filter((chk) => before.has(chk));
  const away = coming.length > 0 ? awayRecord([...before].filter((chk) => !stored.has(chk))) : null;
  const levels = { ...map.levels };
  const levelKeys = new Set(Object.keys(levels));
  for (const records of stored.values()) for (const zk of records.keys()) levelKeys.add(zk);
  for (const zk of levelKeys) {
    const source = levels[zk];
    const written: string[] = [];
    const own: LevelChunks = {};
    if (source) for (const chk of Object.keys(source)) own[chk] = source[chk]!;
    for (const [chk, records] of stored) {
      const cells = records.get(zk);
      const unloaded = source?.[chk] === UNLOADED_CHUNK;
      if (!unloaded && (!cells || source?.[chk])) continue;
      if (cells && !isEmptyRecord(cells)) own[chk] = cells;
      else delete own[chk];
      written.push(chk);
    }
    if (written.length === 0 && coming.length === 0) continue;
    const level = levelOver(coming.length > 0 ? away : awayOf(source), own);
    if (source) lineage.set(level, { parent: new WeakRef(source), keys: written });
    if (isEmptyRecord(level)) delete levels[zk];
    else levels[zk] = level;
  }
  return { version: MAP_FILE_VERSION, levels };
}

export function getStack(map: MapFile, x: number, y: number, z: number): PlacedTile[] {
  const chunk = map.levels[levelKey(z)]?.[chunkKeyFor(x, y)];
  if (!chunk) return [];
  if (chunk === UNLOADED_CHUNK) return UNLOADED_STACK;
  if (!isWholeCell(x, y)) return chunk[coordKey(x, y)] ?? [];
  return cellIndexOf(chunk)[cellSlot(x, y)] ?? [];
}

type CellIndex = Array<PlacedTile[] | undefined>;

const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;
const CHUNK_MASK = CHUNK_SIZE - 1;

/**
 * Chunks are only ever written by `setStacks`, so a chunk's stacks can be
 * filed once by slot and read without building a cell-key string. `setStacks`
 * hands a copied chunk its source's index with the edits applied, and applies
 * an edit written in place to the chunk's own.
 */
const cellIndexByChunk = new WeakMap<ChunkCells, CellIndex>();

/** `| 0` also rejects coordinates past 32 bits, which the mask below would wrap. */
function isWholeCell(x: number, y: number): boolean {
  return (x | 0) === x && (y | 0) === y;
}

/**
 * `CHUNK_SIZE` is a power of two, so masking the two's-complement coordinate
 * gives the cell's offset inside its chunk for negative coordinates too.
 */
function cellSlot(x: number, y: number): number {
  return (x & CHUNK_MASK) * CHUNK_SIZE + (y & CHUNK_MASK);
}

function cellIndexOf(chunk: ChunkCells): CellIndex {
  const cached = cellIndexByChunk.get(chunk);
  if (cached) return cached;
  const index: CellIndex = Array.from({ length: CHUNK_CELLS });
  for (const key in chunk) {
    const { x, y } = parseCoordKey(key);
    if (isWholeCell(x, y)) index[cellSlot(x, y)] = chunk[key];
  }
  cellIndexByChunk.set(chunk, index);
  return index;
}

export function stackOnLevel(
  map: MapFile,
  z: number,
  chunkKey: string,
  cellKey: string,
): PlacedTile[] | undefined {
  const chunk = map.levels[levelKey(z)]?.[chunkKey];
  return chunk === UNLOADED_CHUNK ? UNLOADED_STACK : chunk?.[cellKey];
}

const tileIdsByChunk = new WeakMap<ChunkCells, ReadonlySet<string>>();

/**
 * Every tile id placed in the chunk or held in a placement's `contents`. A
 * chunk copied by `setStacks` inherits its source's set plus what was written,
 * so the set can list a tile that has since left but never misses one.
 */
export function tileIdsInChunk(chunk: ChunkCells): ReadonlySet<string> {
  const cached = tileIdsByChunk.get(chunk);
  if (cached) return cached;
  const found = new Set<string>();
  for (const key in chunk) {
    for (const placed of chunk[key]!) {
      found.add(placed.tileId);
      if (placed.contents) addHeldTileIds(found, placed.contents);
    }
  }
  tileIdsByChunk.set(chunk, found);
  return found;
}

function addHeldTileIds(into: Set<string>, contents: readonly ItemInstance[]) {
  for (const held of contents) {
    into.add(held.tileId);
    if (held.contents) addHeldTileIds(into, held.contents);
  }
}

function listsEveryTileId(ids: ReadonlySet<string>, placed: PlacedTile | ItemInstance): boolean {
  if (!ids.has(placed.tileId)) return false;
  return placed.contents?.every((held) => listsEveryTileId(ids, held)) ?? true;
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

type LineageWalk = { at: object | undefined; keys: string[]; seen: Map<object, number> };

/**
 * Takes one step up a walk's lineage. Returns the version it reached when the
 * other walk has already been there, which is where the two copies diverged.
 */
function stepLineage(walk: LineageWalk, other: LineageWalk): object | undefined {
  const link = walk.at && lineage.get(walk.at);
  const parent = link?.parent.deref();
  if (!link || parent === undefined) {
    walk.at = undefined;
    return undefined;
  }
  for (const key of link.keys) walk.keys.push(key);
  walk.at = parent;
  walk.seen.set(parent, walk.keys.length);
  return other.seen.has(parent) ? parent : undefined;
}

/**
 * Every key written into either record since the version they were both
 * copied from. The two walks go up a step at a time, so two copies of one
 * parent meet after a step each however much history is behind them: the
 * predicted map a client draws is a copy of a different server version every
 * frame, and is never an ancestor of the next one.
 */
function keysWrittenBetween(a: object, b: object): string[] | null {
  const fromA: LineageWalk = { at: a, keys: [], seen: new Map([[a, 0]]) };
  const fromB: LineageWalk = { at: b, keys: [], seen: new Map([[b, 0]]) };
  for (let steps = 0; steps < MAX_LINEAGE_STEPS; steps++) {
    if (!fromA.at && !fromB.at) return null;
    const metByA = stepLineage(fromA, fromB);
    if (metByA) return [...fromA.keys, ...fromB.keys.slice(0, fromB.seen.get(metByA))];
    const metByB = stepLineage(fromB, fromA);
    if (metByB) return [...fromA.keys.slice(0, fromA.seen.get(metByB)), ...fromB.keys];
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

/**
 * A chunk going out of memory or coming back is not a change to what it
 * holds: the store has the same cells either way.
 */
function addChangedCells(out: Set<string>, a: ChunkCells | undefined, b: ChunkCells | undefined) {
  if (a === b || a === UNLOADED_CHUNK || b === UNLOADED_CHUNK) return;
  const written = a && b ? keysWrittenBetween(a, b) : null;
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

export function changedCellsOnLevel(
  prev: MapFile,
  next: MapFile,
  z: number,
  chunkFilter?: ChunkFilter,
): Set<string> {
  const out = new Set<string>();
  const before = prev.levels[levelKey(z)];
  const after = next.levels[levelKey(z)];
  if (before === after) return out;

  const add = (a: ChunkCells | undefined, b: ChunkCells | undefined) => {
    if (a === b || (chunkFilter && !chunkFilter(a, b))) return;
    addChangedCells(out, a, b);
  };
  const chunks = before && after ? keysWrittenBetween(before, after) : null;
  if (chunks) {
    for (const chk of chunks) add(before![chk], after![chk]);
    return out;
  }
  for (const chk in after) add(before?.[chk], after[chk]);
  for (const chk in before) {
    if (after?.[chk] === undefined) add(before[chk], undefined);
  }
  return out;
}

export function changedChunkKeysOnLevel(prev: MapFile, next: MapFile, z: number): string[] {
  const before = prev.levels[levelKey(z)];
  const after = next.levels[levelKey(z)];
  if (before === after) return [];
  const written = before && after ? keysWrittenBetween(before, after) : null;
  const keys = written ?? [...Object.keys(before ?? {}), ...Object.keys(after ?? {})];
  const out: string[] = [];
  for (const chk of new Set(keys)) {
    const a = before?.[chk];
    const b = after?.[chk];
    if (a !== b && a !== UNLOADED_CHUNK && b !== UNLOADED_CHUNK) out.push(chk);
  }
  return out;
}

export type ChunkFilter = (
  before: ChunkCells | undefined,
  after: ChunkCells | undefined,
) => boolean;

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
      /**
       * A chunk only goes out of memory once the store holds it, so it is not
       * written as empty. One coming back is written again, because it may
       * have been changed since and this cannot tell.
       */
      if (a === b || b === UNLOADED_CHUNK) continue;
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

const presentLevelsByLevels = new WeakMap<MapFile["levels"], readonly number[]>();

/**
 * The levels that hold anything, lowest first. A loop over these instead of
 * `MIN_LEVEL..MAX_LEVEL` costs what the world contains rather than how deep it
 * is allowed to go. Cached on the `levels` record, which `setStacks` replaces
 * on every edit.
 */
export function presentLevels(map: MapFile): readonly number[] {
  const cached = presentLevelsByLevels.get(map.levels);
  if (cached) return cached;
  const out: number[] = [];
  for (const key in map.levels) {
    const z = Number(key);
    if (Number.isInteger(z) && z >= MIN_LEVEL && z <= MAX_LEVEL) out.push(z);
  }
  out.sort((a, b) => a - b);
  presentLevelsByLevels.set(map.levels, out);
  return out;
}

/**
 * The levels, lowest first, whose content can reach the heights `loAbs` to
 * `hiAbs`, given that nothing rises more than `reach` units above its own
 * level's floor.
 */
export function levelsReaching(loAbs: number, hiAbs: number, reach: number): number[] {
  const z0 = Math.max(MIN_LEVEL, Math.floor((loAbs - reach) / HEIGHT_PER_LEVEL));
  const z1 = Math.min(MAX_LEVEL, Math.floor(hiAbs / HEIGHT_PER_LEVEL));
  const out: number[] = [];
  for (let z = z0; z <= z1; z++) out.push(z);
  return out;
}

const withAboveByLevels = new WeakMap<MapFile["levels"], readonly number[]>();

/**
 * {@link presentLevels} and the level above each, lowest first: the levels a
 * stack can put a floor under, which is what a column walk that reads the
 * level below has to visit.
 */
export function presentLevelsAndAbove(map: MapFile): readonly number[] {
  const cached = withAboveByLevels.get(map.levels);
  if (cached) return cached;
  const out: number[] = [];
  for (const z of presentLevels(map)) {
    if (out[out.length - 1] !== z) out.push(z);
    if (z < MAX_LEVEL) out.push(z + 1);
  }
  withAboveByLevels.set(map.levels, out);
  return out;
}

/** The levels either map holds anything on, lowest first: every level a diff of the two can find. */
export function presentInEither(a: MapFile, b: MapFile): readonly number[] {
  const left = presentLevels(a);
  if (a.levels === b.levels) return left;
  const right = presentLevels(b);
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const z =
      j >= right.length || (i < left.length && left[i]! <= right[j]!) ? left[i]! : right[j]!;
    if (out[out.length - 1] !== z) out.push(z);
    if (left[i] === z) i++;
    if (right[j] === z) j++;
  }
  return out;
}

export function listChunkKeys(map: MapFile, z: number): string[] {
  const level = map.levels[levelKey(z)];
  return level ? Object.keys(level) : [];
}

export const DRESSED = "~";

/**
 * True when a placement in the drawn map is `tileId`, as itself or as the copy
 * `WornLooks` dressed it in. Notes from the session name the real tile, so the
 * renderer matches them against the drawn map through this.
 */
export function drawnAs(drawnId: string, tileId: string): boolean {
  return drawnId === tileId || drawnId.startsWith(tileId + DRESSED);
}

/** Matches a dressed player too, so the drawn map weighs and stacks bodies as the real one does. */
export function isPlayerBody(placed: PlacedTile): boolean {
  return placed.owner != null && drawnAs(placed.tileId, PLAYER_TILE_ID);
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
  const levels = levelsReaching(abs, abs, MAX_STACK_HEIGHT);
  for (let i = levels.length - 1; i >= 0; i--) {
    const z = levels[i]!;
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
  const levels = levelsReaching(fromAbs, fromAbs, MAX_STACK_HEIGHT);
  for (let i = levels.length - 1; i >= 0; i--) {
    const z = levels[i]!;
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

/**
 * Lets the levels and chunks one `setStacks` copied be written in place by
 * the next, until `seal`. Seal before anything outside the writer can keep a
 * reference to the map: what a draft owns stops being immutable, and every
 * cache keyed on a chunk or level object assumes it is.
 */
export class MapDraft {
  private owned = new WeakSet<object>();

  owns(record: object): boolean {
    return this.owned.has(record);
  }

  adopt(record: object) {
    this.owned.add(record);
  }

  seal() {
    this.owned = new WeakSet();
  }
}

/**
 * A chunk written in place keeps its identity, so a memo that takes an
 * unchanged chunk to mean unchanged contents also compares this count.
 */
const writesInPlace = new WeakMap<ChunkCells, number>();

export function chunkWritesInPlace(chunk: ChunkCells | undefined): number {
  return chunk ? (writesInPlace.get(chunk) ?? 0) : 0;
}

function levelToWrite(
  levels: Record<string, LevelChunks>,
  zk: string,
  draft: MapDraft | undefined,
): LevelChunks {
  const sourceLevel = levels[zk];
  if (sourceLevel && draft?.owns(sourceLevel)) return sourceLevel;
  const level = sourceLevel ? copyLevel(sourceLevel) : {};
  levels[zk] = level;
  if (sourceLevel) lineage.set(level, { parent: new WeakRef(sourceLevel), keys: [] });
  draft?.adopt(level);
  return level;
}

function chunkToWrite(
  level: LevelChunks,
  chk: string,
  draft: MapDraft | undefined,
): { chunk: ChunkCells; keys: string[] } {
  const source = level[chk];
  if (source && draft?.owns(source)) {
    writesInPlace.set(source, chunkWritesInPlace(source) + 1);
    return { chunk: source, keys: lineage.get(source)?.keys ?? [] };
  }
  const chunk: ChunkCells = { ...source };
  level[chk] = chunk;
  lineage.get(level)?.keys.push(chk);
  const keys: string[] = [];
  if (source) lineage.set(chunk, { parent: new WeakRef(source), keys });
  const sourceIndex = source && cellIndexByChunk.get(source);
  if (sourceIndex) cellIndexByChunk.set(chunk, sourceIndex.slice());
  const ids = source && tileIdsByChunk.get(source);
  if (ids) tileIdsByChunk.set(chunk, ids);
  draft?.adopt(chunk);
  return { chunk, keys };
}

/**
 * With a `draft`, a level or chunk that draft copied earlier is written in
 * place instead of copied again. The `MapFile` and its `levels` record are
 * new on every call either way, so a changed map is still a new object.
 */
export function setStacks(map: MapFile, edits: readonly StackEdit[], draft?: MapDraft): MapFile {
  if (!edits.length) return map;

  const levels = { ...map.levels };
  const levelsWritten = new Map<string, LevelChunks>();
  const copied = new Map<string, ChunkCells>();
  const writtenInto = new Map<ChunkCells, string[]>();
  const inherited = new Map<ChunkCells, { ids: ReadonlySet<string>; written: PlacedTile[][] }>();
  let deleted = false;

  for (const edit of edits) {
    const zk = levelKey(edit.z);
    const chk = chunkKeyFor(edit.x, edit.y);
    if (map.levels[zk]?.[chk] === UNLOADED_CHUNK) continue;
    const path = `${zk}/${chk}`;

    let chunk = copied.get(path);
    if (!chunk) {
      let level = levelsWritten.get(zk);
      if (!level) {
        level = levelToWrite(levels, zk, draft);
        levelsWritten.set(zk, level);
      }
      const written = chunkToWrite(level, chk, draft);
      chunk = written.chunk;
      copied.set(path, chunk);
      writtenInto.set(chunk, written.keys);
      const ids = tileIdsByChunk.get(chunk);
      if (ids) inherited.set(chunk, { ids, written: [] });
    }
    inherited.get(chunk)?.written.push(edit.stack);

    const ck = coordKey(edit.x, edit.y);
    writtenInto.get(chunk)!.push(ck);
    const index = isWholeCell(edit.x, edit.y) ? cellIndexByChunk.get(chunk) : undefined;
    if (edit.stack.length === 0) {
      delete chunk[ck];
      if (index) index[cellSlot(edit.x, edit.y)] = undefined;
      deleted = true;
    } else {
      chunk[ck] = edit.stack;
      if (index) index[cellSlot(edit.x, edit.y)] = edit.stack;
    }
  }

  for (const [chunk, { ids, written }] of inherited) {
    let next: Set<string> | null = null;
    for (const stack of written) {
      for (const placed of stack) {
        if (listsEveryTileId(next ?? ids, placed)) continue;
        next ??= new Set(ids);
        next.add(placed.tileId);
        if (placed.contents) addHeldTileIds(next, placed.contents);
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

/**
 * The map with one tile gone from a stack, for reading only. The level is a
 * prototype view over the original, so a level of thousands of chunks is not
 * copied for one cell; anything that lists a level's own keys or stores the
 * result must use `removeTileAt` instead.
 */
export function viewWithoutTileAt(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
): MapFile {
  const zk = levelKey(z);
  const chk = chunkKeyFor(x, y);
  const level = map.levels[zk];
  const source = level?.[chk];
  if (!level || !source || source === UNLOADED_CHUNK) return map;
  const ck = coordKey(x, y);
  const stack = source[ck];
  if (!stack || stackIndex < 0 || stackIndex >= stack.length) return map;
  const chunk: ChunkCells = { ...source };
  const left = stack.filter((_, i) => i !== stackIndex);
  if (left.length === 0) delete chunk[ck];
  else chunk[ck] = left;
  const view = Object.create(level) as LevelChunks;
  view[chk] = chunk;
  return { version: MAP_FILE_VERSION, levels: { ...map.levels, [zk]: view } };
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

/**
 * A placement's `channel` is a comma-separated list, so a door can follow two
 * buttons that each keep their own name. An emitter drives every name listed;
 * a receiver reads them together, as one channel.
 */
export function channelNames(channel: string | undefined): string[] {
  if (!channel) return [];
  return channel
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function listChannels(map: MapFile): string[] {
  const seen = new Set<string>();
  for (const z of presentLevels(map)) {
    for (const { stack } of listCoords(map, z)) {
      for (const placed of stack) {
        for (const name of channelNames(placed.channel)) seen.add(name);
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

export type RewardDraft = {
  tag: string;
  tileIds: readonly string[];
  /** How many of each item to give, by tile id; an id with no entry, or an entry of one, gives one. */
  counts: Readonly<Record<string, number>>;
  minRating: number | null;
};

export function updatePlacedReward(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  draft: RewardDraft,
): MapFile {
  const current = getStack(map, x, y, z);
  const placed = current[stackIndex];
  if (!placed) return map;

  const trimmedTag = draft.tag.trim();
  const kept = draft.tileIds.filter((id) => id.trim());
  const live = trimmedTag !== "" && kept.length > 0;
  const nextTag = live ? trimmedTag : undefined;
  const nextIds = live ? kept : undefined;
  const nextCounts = live ? countsAboveOne(kept, draft.counts) : undefined;
  const nextRating = live && draft.minRating !== null ? draft.minRating : undefined;

  if (
    placed.rewardTag === nextTag &&
    sameIds(placed.rewardTileIds, nextIds) &&
    sameCounts(placed.rewardCounts, nextCounts) &&
    placed.rewardRequires?.rating === nextRating
  ) {
    return map;
  }

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const {
      rewardTag: _tag,
      rewardTileIds: _ids,
      rewardCounts: _counts,
      rewardRequires: _requires,
      ...rest
    } = p;
    if (!live) return rest;
    const counts = nextCounts ? { rewardCounts: nextCounts } : {};
    const requires = nextRating === undefined ? {} : { rewardRequires: { rating: nextRating } };
    return { ...rest, rewardTag: nextTag, rewardTileIds: nextIds, ...counts, ...requires };
  });
  return setStack(map, x, y, z, stack);
}

/** Only the counts that say something, so a reward of one of each writes no `rewardCounts` line. */
function countsAboveOne(
  tileIds: readonly string[],
  counts: Readonly<Record<string, number>>,
): Record<string, number> | undefined {
  const entries = tileIds.flatMap((tileId) => {
    const count = counts[tileId];
    return count !== undefined && count > 1 ? [[tileId, count] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sameCounts(
  a: Readonly<Record<string, number>> | undefined,
  b: Readonly<Record<string, number>> | undefined,
): boolean {
  const aKeys = Object.keys(a ?? {});
  if (aKeys.length !== Object.keys(b ?? {}).length) return false;
  return aKeys.every((key) => a![key] === b?.[key]);
}

export function updatePlacedDepotTag(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  stackIndex: number,
  tag: string,
): MapFile {
  const current = getStack(map, x, y, z);
  const placed = current[stackIndex];
  if (!placed) return map;

  const next = tag.trim() || undefined;
  if (placed.depotTag === next) return map;

  const stack = current.map((p, i) => {
    if (i !== stackIndex) return { ...p };
    const { depotTag: _tag, ...rest } = p;
    return next ? { ...rest, depotTag: next } : rest;
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

/**
 * Yields rather than returning a list: a sweep of a level of two million cells
 * would otherwise hold an entry for every one of them at once, and the
 * startup sweeps in `GameSession` each did.
 */
export function* listCoords(
  map: MapFile,
  z: number,
): Generator<{ x: number; y: number; stack: PlacedTile[] }> {
  const level = map.levels[levelKey(z)];
  if (!level) return;
  for (const chk in level) {
    const chunk = level[chk]!;
    for (const key in chunk) {
      const { x, y } = parseCoordKey(key);
      yield { x, y, stack: chunk[key]! };
    }
  }
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

/**
 * Writes the same text as stringifying `flattenMap(map)` row by row, without
 * building the flat copy or a string per cell at once: a whole island is
 * millions of cells, and those copies cost several times the map itself.
 * Pooled stacks are one array per distinct stack, so each is stringified once.
 */
export function serializeMap(map: MapFile): string {
  const stackText = new Map<readonly PlacedTile[], string>();
  const textOf = (stack: readonly PlacedTile[]) => {
    let text = stackText.get(stack);
    if (text === undefined) {
      text = JSON.stringify(stack.map(authoredPlacement));
      stackText.set(stack, text);
    }
    return text;
  };
  const levels: string[] = [];
  for (const [zk, level] of Object.entries(map.levels)) {
    const xs: number[] = [];
    const ys: number[] = [];
    const stacks: PlacedTile[][] = [];
    for (const chunk of Object.values(level)) {
      for (const [ck, stack] of Object.entries(chunk)) {
        const { x, y } = parseCoordKey(ck);
        xs.push(x);
        ys.push(y);
        stacks.push(stack);
      }
    }
    if (!stacks.length) continue;
    const order = Uint32Array.from(stacks.keys()).sort(
      (a, b) => xs[a]! - xs[b]! || ys[a]! - ys[b]!,
    );
    const parts: string[] = [];
    let rows: string[] = [];
    for (const i of order) {
      rows.push(`      "${xs[i]},${ys[i]}": ${textOf(stacks[i]!)}`);
      if (rows.length === SERIALIZED_ROWS_PER_PART) {
        parts.push(rows.join(",\n"));
        rows = [];
      }
    }
    if (rows.length) parts.push(rows.join(",\n"));
    levels.push(`    ${JSON.stringify(zk)}: {\n${parts.join(",\n")}\n    }`);
  }
  const body = levels.length ? `{\n${levels.join(",\n")}\n  }` : "{}";
  return `{\n  "version": ${MAP_FILE_VERSION},\n  "levels": ${body}\n}\n`;
}

const SERIALIZED_ROWS_PER_PART = 4096;

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
  return chunkifyMap(parseFlatMap(json));
}

/**
 * A copy of `map` that its caller cannot reach into: every chunk is a new
 * record, a stack holding nested data is deep-copied, and every other stack is
 * the pool's shared frozen copy.
 */
export function shareMap(map: MapFile, pool = new StackPool()): MapFile {
  const levels: Record<string, LevelChunks> = {};
  for (const zk in map.levels) {
    const own: LevelChunks = {};
    const from = map.levels[zk]!;
    for (const chk of Object.keys(from)) {
      const cells = from[chk]!;
      own[chk] = cells === UNLOADED_CHUNK ? UNLOADED_CHUNK : shareCells(cells, pool, true);
    }
    levels[zk] = levelOver(awayOf(from), own);
  }
  return { version: MAP_FILE_VERSION, levels };
}

/** `copy` is for cells the caller does not own; parsed cells are pooled in place. */
export function shareCells(cells: ChunkCells, pool: StackPool, copy = false): ChunkCells {
  const out: ChunkCells = copy ? {} : cells;
  for (const ck in cells) {
    const stack = cells[ck]!;
    const shared = pool.share(stack);
    out[ck] = copy && shared === stack && !isPooledStack(stack) ? structuredClone(stack) : shared;
  }
  return out;
}

const SERIALIZED_HEAD = `{\n  "version": ${MAP_FILE_VERSION},\n  "levels": {\n`;
const SERIALIZED_LEVEL = /^ {4}"(-?\d+)": \{$/;
const SERIALIZED_LEVEL_END = /^ {4}\},?$/;
const SERIALIZED_CELL = /^ {6}"(-?\d+,-?\d+)": (\[.*\]),?$/;

/**
 * `parseMap` for a world about to be played, which never needs the whole
 * file's object tree at once. A file laid out the way `serializeMap` writes
 * it, one cell to a line, is read a line at a time and only the first copy of
 * each distinct stack is parsed. Any other layout is parsed whole.
 */
export function parseSharedMap(json: string, pool = new StackPool()): MapFile {
  return parseByLine(json, pool) ?? shareMap(parseMap(json), pool);
}

function parseByLine(json: string, pool: StackPool): MapFile | null {
  if (!json.startsWith(SERIALIZED_HEAD)) return null;
  const levels: Record<string, LevelChunks> = {};
  let level: LevelChunks | null = null;
  let at = SERIALIZED_HEAD.length;
  let closed = false;
  while (at < json.length) {
    let end = json.indexOf("\n", at);
    if (end < 0) end = json.length;
    const line = json.slice(at, end);
    at = end + 1;
    if (closed) {
      if (line === "" || line === "}") continue;
      return null;
    }
    if (level) {
      const cell = SERIALIZED_CELL.exec(line);
      if (cell) {
        const ck = cell[1]!;
        const { x, y } = parseCoordKey(ck);
        const stack = pool.shareText(cell[2]!);
        if (stack.length) (level[chunkKeyFor(x, y)] ??= {})[ck] = stack;
        continue;
      }
      if (!SERIALIZED_LEVEL_END.test(line)) return null;
      level = null;
      continue;
    }
    const opened = SERIALIZED_LEVEL.exec(line);
    if (opened) {
      level = {};
      levels[opened[1]!] = level;
      continue;
    }
    if (line !== "  }") return null;
    closed = true;
  }
  if (!closed || level) return null;
  for (const zk in levels) if (isEmptyRecord(levels[zk]!)) delete levels[zk];
  return { version: MAP_FILE_VERSION, levels };
}

export function parseFlatMap(json: string): FlatMapFile {
  const data = JSON.parse(json) as FlatMapFile;
  if ((data.version as number) === INSCRIPTIONS_WERE_DESCRIPTIONS) return liftInscriptions(data);
  if (data.version !== MAP_FILE_VERSION) {
    throw new Error(`Unsupported map version: ${String(data.version)}`);
  }
  return data;
}
