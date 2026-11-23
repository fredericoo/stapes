import type { ItemInstance } from "../lib/itemInstance";
import {
  boardWithAway,
  chunkIndexOf,
  chunkKeyAt,
  chunkKeyFor,
  UNLOADED_CHUNK,
  UNLOADED_TILE_ID,
} from "../lib/mapData";
import type { ChunkCells, Coord, LevelChunks, MapFile, PlacedTile, TileDef } from "../lib/types";
import { parseCoordKey } from "../lib/types";
import { resolveTeleport } from "../lib/interactions";
import { getStack, setStacks, type StackEdit, tileIdsInChunk } from "../lib/mapData";
import { listActorOwners, listResidentBodies, type ResidentIds } from "./actors";
import { cellKey } from "./pressurePlates";
import { findWiredCells } from "./signals";

export const UNLOADED_TILE: TileDef = {
  id: UNLOADED_TILE_ID,
  name: "Unloaded",
  height: 4,
  type: "simple",
  kind: "prop",
  attributes: {},
  anchor: { tilesetId: "", x: 0, y: 0 },
  walkable: false,
  sprite: { frames: [] },
} as unknown as TileDef;

export function chunksAround(cells: Iterable<Coord>, reach: number): Set<string> {
  const out = new Set<string>();
  for (const cell of cells) {
    const cx = chunkIndexOf(cell.x);
    const cy = chunkIndexOf(cell.y);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) out.add(chunkKeyAt(cx + dx, cy + dy));
    }
  }
  return out;
}

/** Each chunk key the board holds a real record for, on any level. */
export function loadedChunkKeys(map: MapFile): Set<string> {
  const out = new Set<string>();
  for (const zk in map.levels) {
    const level = map.levels[zk]!;
    for (const chk of Object.keys(level)) if (level[chk] !== UNLOADED_CHUNK) out.add(chk);
  }
  return out;
}

/** The chunk's records by level key, for the store or for a sweep of just that chunk. */
export function chunkRecords(map: MapFile, chunkKey: string): Map<string, ChunkCells> {
  const out = new Map<string, ChunkCells>();
  for (const zk in map.levels) {
    const cells = map.levels[zk]![chunkKey];
    if (cells && cells !== UNLOADED_CHUNK) out.set(zk, cells);
  }
  return out;
}

export function* cellsOf(
  records: ReadonlyMap<string, ChunkCells>,
): Generator<{ cell: Coord; stack: PlacedTile[] }> {
  for (const [zk, cells] of records) {
    const z = Number(zk);
    for (const key in cells) {
      const { x, y } = parseCoordKey(key);
      yield { cell: { x, y, z }, stack: cells[key]! };
    }
  }
}

export function itemIdsIn(stack: readonly PlacedTile[], into: Set<string>) {
  for (const placed of stack) {
    if (placed.itemId) into.add(placed.itemId);
    if (placed.contents) heldIds(placed.contents, into);
  }
}

function heldIds(contents: readonly ItemInstance[], into: Set<string>) {
  for (const held of contents) {
    into.add(held.id);
    if (held.contents) heldIds(held.contents, into);
  }
}

/** Where a placement in `records` sends whoever uses it. */
export function teleportTargetsIn(
  records: ReadonlyMap<string, ChunkCells>,
  tilesById: Record<string, TileDef>,
  into: Coord[],
) {
  for (const { cell, stack } of cellsOf(records)) {
    for (const placed of stack) {
      const to = resolveTeleport(placed, tilesById[placed.tileId], cell)?.to;
      if (to) into.push(to);
    }
  }
}

/** Every `teleport` command in any tile's dialog, which can run wherever the speaker stands. */
export function dialogTeleportTargets(tilesById: Record<string, TileDef>): Coord[] {
  const out: Coord[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const one of value) walk(one);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.kind === "teleport" && isCoord(record.to)) out.push(record.to);
    for (const key in record) walk(record[key]);
  };
  for (const id in tilesById) walk(tilesById[id]!.interactions?.dialog);
  return out;
}

function isCoord(value: unknown): value is Coord {
  if (!value || typeof value !== "object") return false;
  const { x, y, z } = value as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof z === "number";
}

export function chunkOfCell(cell: Coord): string {
  return chunkKeyFor(cell.x, cell.y);
}

/**
 * What a world needs to start without its whole board in memory: the chunks
 * to start with, where every teleport sends a body by the chunk the teleport
 * stands in, the chunk each resident body is in, and the resident count to
 * mint from. None of these can be read off a board whose chunks are not all there.
 */
export type ResidencyIndex = {
  kept: string[];
  teleports: Record<string, Coord[]>;
  residents: Record<string, string>;
  residentIdsFrom: number;
};

export function teleportTileIds(tilesById: Record<string, TileDef>): string[] {
  return Object.keys(tilesById).filter((id) => tilesById[id]!.interactions?.teleport != null);
}

/** Where each chunk that holds a teleport sends a body, for every loaded chunk of `map`. */
export function teleportTargetsByChunk(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  into = new Map<string, Coord[]>(),
): Map<string, Coord[]> {
  const ids = teleportTileIds(tilesById);
  if (ids.length === 0) return into;
  const seen = new Set<string>();
  for (const zk in map.levels) {
    const level = map.levels[zk]!;
    for (const chk of Object.keys(level)) {
      const cells = level[chk]!;
      if (cells === UNLOADED_CHUNK) continue;
      if (!seen.has(chk)) {
        seen.add(chk);
        into.delete(chk);
      }
      const held = tileIdsInChunk(cells);
      if (!ids.some((id) => held.has(id))) continue;
      const targets = into.get(chk) ?? [];
      teleportTargetsIn(new Map([[zk, cells]]), tilesById, targets);
      if (targets.length > 0) into.set(chk, targets);
    }
  }
  return into;
}

/**
 * Gives every resident body without an owner one, in one write, the way
 * `GameSession` adopts them, so a board can be written to the store before a
 * session holds any of it.
 */
export function ownResidentBodies(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ids: ResidentIds,
): MapFile {
  const owned = listActorOwners(map);
  const edits = new Map<string, StackEdit>();
  for (const body of listResidentBodies(map, tilesById)) {
    if (body.placed.owner) continue;
    const owner = ids.mint(owned);
    const key = cellKey(body);
    let edit = edits.get(key);
    if (!edit) {
      edit = { x: body.x, y: body.y, z: body.z, stack: [...getStack(map, body.x, body.y, body.z)] };
      edits.set(key, edit);
    }
    edit.stack[body.stackIndex] = { ...body.placed, owner };
  }
  return setStacks(map, [...edits.values()]);
}

/** The index of a whole board, which keeps the spawn, wired cells and teleport targets. */
export function residencyIndexOf(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  spawn: Coord,
  residentIdsFrom: number,
): ResidencyIndex {
  const teleports = teleportTargetsByChunk(map, tilesById);
  const cells: Coord[] = [spawn, ...findWiredCells(map), ...dialogTeleportTargets(tilesById)];
  for (const targets of teleports.values()) cells.push(...targets);
  const residents: Record<string, string> = {};
  for (const body of listResidentBodies(map, tilesById)) {
    if (body.placed.owner) residents[body.placed.owner] = chunkOfCell(body);
  }
  return {
    kept: [...chunksAround(cells, 1)],
    teleports: Object.fromEntries(teleports),
    residents,
    residentIdsFrom,
  };
}

/**
 * `map` with only `keep` in memory: every other chunk is `UNLOADED_CHUNK` on
 * every level the board has, including levels only an unloaded chunk reaches.
 */
export function boardKeeping(map: MapFile, keep: ReadonlySet<string>): MapFile {
  const levels: MapFile["levels"] = {};
  const away = new Set<string>();
  for (const zk in map.levels) {
    const level: LevelChunks = {};
    const from = map.levels[zk]!;
    for (const chk in from) {
      if (!keep.has(chk)) away.add(chk);
      else if (from[chk] !== UNLOADED_CHUNK) level[chk] = from[chk]!;
    }
    levels[zk] = level;
  }
  return boardWithAway(levels, away);
}
