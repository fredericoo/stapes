import { chunkKeyAt, chunkKeyFor, getChunk, listChunkKeys } from "../lib/mapData";
import { LIGHT_APRON, LIGHT_CHUNK_SIZE, LIGHT_WINDOW_MARGIN } from "../lib/lightingChunks";
import { MAX_LIGHT_LEVEL } from "../lib/types";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL, levelKey } from "../lib/types";
import { MAP_FILE_VERSION } from "../lib/types";
import type { FlatMapFile, MapFile, PlacedTile } from "../lib/types";
import { MESH_WINDOW_MARGIN, VIEW_CELLS } from "../lib/view";

export const INTEREST_REACH_CELLS =
  Math.ceil(VIEW_CELLS / 2) +
  (MAX_LEVEL - MIN_LEVEL) +
  LIGHT_WINDOW_MARGIN +
  LIGHT_CHUNK_SIZE +
  LIGHT_APRON;

export const INTEREST_REACH_CHUNKS = Math.ceil(INTEREST_REACH_CELLS / CHUNK_SIZE);

export const BODY_REACH_ON_LEVEL = Math.ceil(VIEW_CELLS / 2) + MESH_WINDOW_MARGIN + MAX_LIGHT_LEVEL;

export const BODY_REACH_CELLS = BODY_REACH_ON_LEVEL + (MAX_LEVEL - MIN_LEVEL);

export function withinBodyReach(
  at: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
): boolean {
  return withinBodyReachOf(at.x, at.y, at.z, x, y, z);
}

export function withinBodyReachOf(
  atX: number,
  atY: number,
  atZ: number,
  x: number,
  y: number,
  z: number,
): boolean {
  const reach = BODY_REACH_ON_LEVEL + Math.abs(z - atZ);
  return Math.abs(x - atX) <= reach && Math.abs(y - atY) <= reach;
}

const BODY_GRID_CELLS = CHUNK_SIZE;

/** One number per bucket: offset by 0x8000 so a negative coordinate cannot collide with a positive one. */
function bodyGridKey(bx: number, by: number): number {
  return (bx + 0x8000) * 0x10000 + (by + 0x8000);
}

export class BodyGrid {
  private readonly buckets = new Map<number, number[]>();

  constructor(private readonly bodies: ReadonlyArray<{ x: number; y: number; z: number }>) {
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!;
      const key = bodyGridKey(
        Math.floor(body.x / BODY_GRID_CELLS),
        Math.floor(body.y / BODY_GRID_CELLS),
      );
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  near(at: { x: number; y: number; z: number }): number[] {
    const out: number[] = [];
    const minX = Math.floor((at.x - BODY_REACH_CELLS) / BODY_GRID_CELLS);
    const maxX = Math.floor((at.x + BODY_REACH_CELLS) / BODY_GRID_CELLS);
    const minY = Math.floor((at.y - BODY_REACH_CELLS) / BODY_GRID_CELLS);
    const maxY = Math.floor((at.y + BODY_REACH_CELLS) / BODY_GRID_CELLS);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        const bucket = this.buckets.get(bodyGridKey(bx, by));
        if (!bucket) continue;
        for (const i of bucket) {
          const body = this.bodies[i]!;
          if (withinBodyReach(at, body.x, body.y, body.z)) out.push(i);
        }
      }
    }
    return out;
  }
}

export function interestChunks(x: number, y: number): Set<string> {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const out = new Set<string>();
  for (let dx = -INTEREST_REACH_CHUNKS; dx <= INTEREST_REACH_CHUNKS; dx++) {
    for (let dy = -INTEREST_REACH_CHUNKS; dy <= INTEREST_REACH_CHUNKS; dy++) {
      out.add(chunkKeyAt(cx + dx, cy + dy));
    }
  }
  return out;
}

export function covers(chunks: ReadonlySet<string>, x: number, y: number): boolean {
  return chunks.has(chunkKeyFor(x, y));
}

export function sameChunks(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean {
  if (a === undefined || a.size !== b.size) return false;
  for (const key of b) if (!a.has(key)) return false;
  return true;
}

export function chunksEntered(
  before: ReadonlySet<string> | undefined,
  now: ReadonlySet<string>,
  at: { x: number; y: number },
): string[] {
  const out: string[] = [];
  for (const key of now) {
    if (before?.has(key)) continue;
    out.push(key);
  }
  if (out.length < 2) return out;
  const cx = Math.floor(at.x / CHUNK_SIZE);
  const cy = Math.floor(at.y / CHUNK_SIZE);
  const distance = (key: string) => {
    const comma = key.indexOf(",");
    const kx = Number(key.slice(0, comma));
    const ky = Number(key.slice(comma + 1));
    return Math.max(Math.abs(kx - cx), Math.abs(ky - cy));
  };
  return out.sort((a, b) => distance(a) - distance(b));
}

export function visibleStack(stack: PlacedTile[], held: ReadonlySet<string>): PlacedTile[] {
  let out: PlacedTile[] | null = null;
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i]!;
    if (!placed.owner || held.has(placed.owner)) {
      out?.push(placed);
      continue;
    }
    out ??= stack.slice(0, i);
  }
  return out ?? stack;
}

export function cellsOfChunks(
  map: MapFile,
  chunks: Iterable<string>,
  held: ReadonlySet<string>,
): Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> {
  const out: Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> = [];
  for (const chunk of chunks) {
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      const cells = getChunk(map, z, chunk);
      if (!cells) continue;
      for (const key in cells) {
        const comma = key.indexOf(",");
        out.push({
          x: Number(key.slice(0, comma)),
          y: Number(key.slice(comma + 1)),
          z,
          stack: visibleStack(cells[key]!, held),
        });
      }
    }
  }
  return out;
}

export function mapOfInterest(
  map: MapFile,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
): FlatMapFile {
  const levels: FlatMapFile["levels"] = {};
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const present = listChunkKeys(map, z);
    const walk = present.length < chunks.size ? present : [...chunks];
    for (const chunk of walk) {
      if (!chunks.has(chunk)) continue;
      const cells = getChunk(map, z, chunk);
      if (!cells) continue;
      for (const key in cells) {
        (levels[levelKey(z)] ??= {})[key] = visibleStack(cells[key]!, held);
      }
    }
  }
  return { version: MAP_FILE_VERSION, levels };
}
