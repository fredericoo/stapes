import type { Direction, FlatMapFile, PlacedTile } from "../../app/lib/types";
import { MAP_FILE_VERSION, coordKey } from "../../app/lib/types";

/**
 * The map being written, one sparse layer per level keyed by grid index.
 * `ox`, `oy` is the map coordinate of grid cell 0,0, so the island is placed
 * with the wreck beach at the map's origin.
 */
export class Board {
  readonly levels = new Map<number, Map<number, PlacedTile[]>>();
  constructor(
    readonly width: number,
    readonly height: number,
    readonly ox: number,
    readonly oy: number,
  ) {}

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  layer(z: number): Map<number, PlacedTile[]> {
    let layer = this.levels.get(z);
    if (!layer) {
      layer = new Map();
      this.levels.set(z, layer);
    }
    return layer;
  }

  get(x: number, y: number, z: number): PlacedTile[] | undefined {
    return this.levels.get(z)?.get(this.index(x, y));
  }

  set(x: number, y: number, z: number, stack: PlacedTile[]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (stack.length === 0) this.levels.get(z)?.delete(this.index(x, y));
    else this.layer(z).set(this.index(x, y), stack);
  }

  push(x: number, y: number, z: number, ...tiles: PlacedTile[]): void {
    const stack = this.get(x, y, z);
    if (stack) stack.push(...tiles);
    else this.set(x, y, z, tiles);
  }

  /** The top tile id of a stack, or undefined. */
  top(x: number, y: number, z: number): string | undefined {
    const stack = this.get(x, y, z);
    return stack?.[stack.length - 1]?.tileId;
  }

  toFlat(): FlatMapFile {
    const levels: FlatMapFile["levels"] = {};
    for (const z of [...this.levels.keys()].sort((a, b) => a - b)) {
      const layer = this.levels.get(z)!;
      const cells: Record<string, PlacedTile[]> = {};
      for (const [i, stack] of layer) {
        const x = i % this.width;
        const y = (i - x) / this.width;
        cells[coordKey(x + this.ox, y + this.oy)] = stack;
      }
      levels[String(z)] = cells;
    }
    return { version: MAP_FILE_VERSION, levels };
  }

  /**
   * Only the cells inside `rect`, with `ring` cells of open sea round them,
   * since the sea is all that keeps a body from walking off the map
   * (`docs/terrain.md`). The first cell of sea past land has `water` under it.
   * A cave below level 0 is kept only if all of it is inside, since one cut by
   * the crop would open on to the edge of the map.
   */
  crop(rect: { x0: number; y0: number; x1: number; y1: number }, ring: number): Board {
    const out = new Board(this.width, this.height, this.ox, this.oy);
    const inside = (i: number) => {
      const x = i % this.width;
      const y = (i - x) / this.width;
      return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
    };
    for (const [z, layer] of this.levels) {
      const kept = z >= 0 ? null : this.wholePiecesInside(layer, inside);
      for (const [i, stack] of layer) {
        if (!inside(i) || (kept && !kept.has(i))) continue;
        out.set(i % this.width, Math.floor(i / this.width), z, stack);
      }
    }
    for (let y = rect.y0 - ring; y <= rect.y1 + ring; y++) {
      for (let x = rect.x0 - ring; x <= rect.x1 + ring; x++) {
        if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) continue;
        const edge =
          x === rect.x0 - 1 || x === rect.x1 + 1 || y === rect.y0 - 1 || y === rect.y1 + 1;
        out.set(x, y, 0, edge ? [tile("water"), tile("deep-water")] : [tile("deep-water")]);
      }
    }
    return out;
  }

  /** The cells of every eight-way piece of `layer` that lies wholly inside. */
  private wholePiecesInside(
    layer: Map<number, PlacedTile[]>,
    inside: (i: number) => boolean,
  ): Set<number> {
    const kept = new Set<number>();
    const seen = new Set<number>();
    for (const start of layer.keys()) {
      if (seen.has(start)) continue;
      const piece = [start];
      seen.add(start);
      for (let k = 0; k < piece.length; k++) {
        const i = piece[k]!;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const j = i + dy * this.width + dx;
            if (layer.has(j) && !seen.has(j)) {
              seen.add(j);
              piece.push(j);
            }
          }
      }
      if (piece.every(inside)) for (const i of piece) kept.add(i);
    }
    return kept;
  }

  cellCount(): number {
    let n = 0;
    for (const layer of this.levels.values()) n += layer.size;
    return n;
  }
}

export const tile = (
  tileId: string,
  direction?: Direction,
  extra?: Partial<PlacedTile>,
): PlacedTile => (direction ? { tileId, direction, ...extra } : { tileId, ...extra });
