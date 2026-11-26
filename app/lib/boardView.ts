import { chunkKey, type ChangedChunk } from "./mapData";
import { levelScreenOffset } from "./geometry";
import {
  CELL_SIZE,
  CHUNK_SIZE,
  levelKey,
  MAP_FILE_VERSION,
  parseCoordKey,
  type ChunkCells,
  type LevelChunks,
  type MapFile,
} from "./types";
import { type LevelRange, viewLevels } from "./view";

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

/** The levels the board has that the renderer draws round `level`, none above `topLevel`. */
export function drawnLevels(
  level: number,
  levels: readonly number[],
  topLevel: number = Number.POSITIVE_INFINITY,
): number[] {
  const { z0, z1 } = viewLevels(level);
  return levels.filter((z) => z >= z0 && z <= Math.min(z1, topLevel));
}

/**
 * The chunks a camera shows on any of the `drawn` levels, nearest the middle
 * of the view on `level` first. Level `z` is drawn `z` cells up and to the
 * left, so the same spot on screen is a cell further down and right on a
 * higher level.
 */
export function chunksInView(
  camera: CameraRect,
  level: number,
  drawn: readonly number[],
): string[] {
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
 * The chunks a viewer has read from the server's board, each on the levels it
 * was read for. A level that was read and had no row is remembered as read
 * (`null`), so it is not asked for again.
 */
export class BoardChunks {
  private readonly read = new Map<string, Map<number, ChunkCells | null>>();
  private readonly stored: ReadonlySet<string>;

  constructor(stored: Iterable<string>) {
    this.stored = new Set(stored);
  }

  get size(): number {
    return this.read.size;
  }

  /** Of `keys`, in their order, those the board has and this has not read on every one of `levels`. */
  missing(keys: readonly string[], levels: readonly number[]): string[] {
    return keys.filter((key) => {
      if (!this.stored.has(key)) return false;
      const held = this.read.get(key);
      return !held || levels.some((z) => !held.has(z));
    });
  }

  /** The narrowest range of `levels` that covers every one some chunk of `keys` has not read. */
  missingRange(keys: readonly string[], levels: readonly number[]): LevelRange | null {
    let z0 = Number.POSITIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (const key of keys) {
      const held = this.read.get(key);
      for (const z of levels) {
        if (held?.has(z)) continue;
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
    }
    return z0 > z1 ? null : { z0, z1 };
  }

  /** Records `asked` as read on `levels` of the board, `rows` being every row they had there. */
  add(asked: readonly string[], levels: readonly number[], rows: readonly ChangedChunk[]): void {
    for (const key of asked) {
      let held = this.read.get(key);
      if (!held) this.read.set(key, (held = new Map()));
      for (const z of levels) held.set(z, null);
    }
    for (const row of rows) this.read.get(row.chunkKey)?.set(Number(row.levelKey), row.cells);
  }

  /**
   * Forgets every chunk more than `margin` chunks outside the box round
   * `keep`, and every level outside `levels`. Returns whether it forgot
   * anything, so the page knows to hand the renderer a smaller board.
   */
  trim(keep: readonly string[], levels: LevelRange, margin: number): boolean {
    const at = keep.map(parseCoordKey);
    const minX = Math.min(...at.map((c) => c.x)) - margin;
    const maxX = Math.max(...at.map((c) => c.x)) + margin;
    const minY = Math.min(...at.map((c) => c.y)) - margin;
    const maxY = Math.max(...at.map((c) => c.y)) + margin;
    let dropped = false;
    for (const [key, held] of this.read) {
      const { x, y } = parseCoordKey(key);
      if (x < minX || x > maxX || y < minY || y > maxY) {
        this.read.delete(key);
        dropped = true;
        continue;
      }
      for (const z of held.keys()) {
        if (z >= levels.z0 && z <= levels.z1) continue;
        held.delete(z);
        dropped = true;
      }
    }
    return dropped;
  }

  /** The chunks read so far as a board, without any level above `topLevel`. */
  map(topLevel: number = Number.POSITIVE_INFINITY): MapFile {
    const levels: Record<string, LevelChunks> = {};
    for (const [key, held] of this.read) {
      for (const [z, cells] of held) {
        if (z > topLevel || !cells) continue;
        (levels[levelKey(z)] ??= {})[key] = cells;
      }
    }
    return { version: MAP_FILE_VERSION, levels };
  }
}
