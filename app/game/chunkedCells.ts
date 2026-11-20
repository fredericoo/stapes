import { chunkKeyFor, chunkWritesInPlace, getChunk } from "../lib/mapData";
import type { ChunkCells, Coord, MapFile } from "../lib/types";
import { coordKey } from "../lib/types";

export type ChunkSettle = {
  map: MapFile;
  changed: Coord[];
};

type ChunkStamp = { chunk: ChunkCells | undefined; writes: number };

/**
 * `stamps` are the chunks the group's cells read, from `below` levels under
 * it to `above` levels over it, as they were when the group last settled to
 * no change. A chunk is replaced or has its write count raised whenever a
 * stack in it is written, so while every stamp holds the group would settle
 * to no change again.
 */
type Group<T> = {
  z: number;
  chunkKey: string;
  entries: Map<string, T>;
  stamps: ChunkStamp[] | null;
};

/**
 * Cells grouped by chunk, so a settle pass skips every chunk whose
 * neighbourhood is unchanged since it last settled to no change, and costs
 * what changed rather than how many cells there are.
 */
export class ChunkedCells<T> {
  private readonly groups = new Map<string, Group<T>>();
  private count = 0;

  constructor(
    private readonly below: number,
    private readonly above: number,
    private readonly entryFor: (cell: Coord) => T,
  ) {}

  get size(): number {
    return this.count;
  }

  add(cell: Coord) {
    const chunkKey = chunkKeyFor(cell.x, cell.y);
    const groupKey = `${cell.z}:${chunkKey}`;
    let group = this.groups.get(groupKey);
    if (!group) {
      group = { z: cell.z, chunkKey, entries: new Map(), stamps: null };
      this.groups.set(groupKey, group);
    }
    const key = coordKey(cell.x, cell.y);
    if (group.entries.has(key)) return;
    group.entries.set(key, this.entryFor(cell));
    group.stamps = null;
    this.count++;
  }

  delete(cell: Coord) {
    const groupKey = `${cell.z}:${chunkKeyFor(cell.x, cell.y)}`;
    const group = this.groups.get(groupKey);
    if (!group?.entries.delete(coordKey(cell.x, cell.y))) return;
    this.count--;
    if (group.entries.size === 0) this.groups.delete(groupKey);
  }

  settle(
    map: MapFile,
    settleGroup: (map: MapFile, entries: Iterable<T>) => ChunkSettle,
  ): { map: MapFile; changed: Coord[] } {
    const changed: Coord[] = [];
    let next = map;
    for (const group of this.groups.values()) {
      if (group.stamps && this.stampsHold(next, group, group.stamps)) continue;
      const result = settleGroup(next, group.entries.values());
      next = result.map;
      changed.push(...result.changed);
      group.stamps = result.changed.length === 0 ? this.stampsOf(next, group) : null;
    }
    return { map: next, changed };
  }

  private stampsOf(map: MapFile, group: Group<T>): ChunkStamp[] {
    const stamps: ChunkStamp[] = [];
    for (let z = group.z - this.below; z <= group.z + this.above; z++) {
      const chunk = getChunk(map, z, group.chunkKey);
      stamps.push({ chunk, writes: chunkWritesInPlace(chunk) });
    }
    return stamps;
  }

  private stampsHold(map: MapFile, group: Group<T>, stamps: ChunkStamp[]): boolean {
    for (let i = 0; i < stamps.length; i++) {
      const chunk = getChunk(map, group.z - this.below + i, group.chunkKey);
      const stamp = stamps[i]!;
      if (chunk !== stamp.chunk || chunkWritesInPlace(chunk) !== stamp.writes) return false;
    }
    return true;
  }
}
