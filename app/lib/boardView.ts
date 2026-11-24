import { chunkKey, type ChangedChunk } from "./mapData";
import { levelScreenOffset } from "./geometry";
import { CELL_SIZE, CHUNK_SIZE, MAP_FILE_VERSION, type LevelChunks, type MapFile } from "./types";
import { viewLevels } from "./view";

/** Joins chunk keys in a board read's query; a chunk key itself holds a comma. */
export const BOARD_CHUNK_SEPARATOR = ";";

export type BoardOutline = {
  chunks: string[];
  levels: number[];
  spawn: { x: number; y: number; z: number } | null;
};

/** The part of the world a camera shows, in world pixels. */
export type CameraRect = { left: number; top: number; width: number; height: number };

/**
 * Chunks round the edge of what is drawn, read before they scroll in. One also
 * covers a tall sprite whose cell is below the bottom of the view.
 */
const MARGIN_CHUNKS = 1;

/**
 * The chunks a camera shows on any level the renderer draws round `level`,
 * nearest the middle of the view first. Level `z` is drawn `z` cells up and to
 * the left, so the same spot on screen is a cell further down and right on a
 * higher level.
 */
export function chunksInView(
  camera: CameraRect,
  level: number,
  levels: readonly number[],
  topLevel: number = Number.POSITIVE_INFINITY,
): string[] {
  const { z0, z1 } = viewLevels(level);
  const drawn = levels.filter((z) => z >= z0 && z <= Math.min(z1, topLevel));
  if (drawn.length === 0) return [];
  const chunkOf = (px: number, offset: number) =>
    Math.floor((px - offset) / CELL_SIZE / CHUNK_SIZE);
  const shifts = drawn.map(levelScreenOffset);
  const minX = Math.min(...shifts.map((s) => chunkOf(camera.left, s.x))) - MARGIN_CHUNKS;
  const maxX =
    Math.max(...shifts.map((s) => chunkOf(camera.left + camera.width, s.x))) + MARGIN_CHUNKS;
  const minY = Math.min(...shifts.map((s) => chunkOf(camera.top, s.y))) - MARGIN_CHUNKS;
  const maxY =
    Math.max(...shifts.map((s) => chunkOf(camera.top + camera.height, s.y))) + MARGIN_CHUNKS;

  const centre = levelScreenOffset(level);
  const midX = chunkOf(camera.left + camera.width / 2, centre.x);
  const midY = chunkOf(camera.top + camera.height / 2, centre.y);
  const out: { key: string; distance: number }[] = [];
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      out.push({ key: chunkKey(cx, cy), distance: Math.hypot(cx - midX, cy - midY) });
    }
  }
  return out.sort((a, b) => a.distance - b.distance).map((c) => c.key);
}

/**
 * The chunks a viewer has read from the server's board. A chunk that was read
 * and had no rows is remembered as read, so it is not asked for again.
 */
export class BoardChunks {
  private readonly read = new Map<string, ChangedChunk[]>();
  private readonly stored: ReadonlySet<string>;

  constructor(stored: Iterable<string>) {
    this.stored = new Set(stored);
  }

  get size(): number {
    return this.read.size;
  }

  /** Of `keys`, in their order, those the board has and this has not read. */
  missing(keys: readonly string[]): string[] {
    return keys.filter((key) => this.stored.has(key) && !this.read.has(key));
  }

  add(asked: readonly string[], rows: readonly ChangedChunk[]): void {
    for (const key of asked) this.read.set(key, []);
    for (const row of rows) this.read.get(row.chunkKey)?.push(row);
  }

  /**
   * Forgets the chunks read longest ago until at most `max` are held, never
   * one of `keep`. A `Map` iterates in insertion order, so the oldest come first.
   */
  trim(keep: readonly string[], max: number): void {
    if (this.read.size <= max) return;
    const kept = new Set(keep);
    for (const key of this.read.keys()) {
      if (this.read.size <= max) return;
      if (!kept.has(key)) this.read.delete(key);
    }
  }

  /** The chunks read so far as a board, without any level above `topLevel`. */
  map(topLevel: number = Number.POSITIVE_INFINITY): MapFile {
    const levels: Record<string, LevelChunks> = {};
    for (const rows of this.read.values()) {
      for (const { levelKey, chunkKey: key, cells } of rows) {
        if (Number(levelKey) > topLevel) continue;
        (levels[levelKey] ??= {})[key] = cells;
      }
    }
    return { version: MAP_FILE_VERSION, levels };
  }
}
