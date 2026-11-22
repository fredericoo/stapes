import type { ItemInstance } from "../lib/itemInstance";
import {
  chunkIndexOf,
  chunkKeyAt,
  chunkKeyFor,
  UNLOADED_CHUNK,
  UNLOADED_TILE_ID,
} from "../lib/mapData";
import type { ChunkCells, Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { parseCoordKey } from "../lib/types";
import { resolveTeleport } from "../lib/interactions";

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
    for (const chk in level) if (level[chk] !== UNLOADED_CHUNK) out.add(chk);
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
