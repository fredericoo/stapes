/**
 * PROTOTYPE — the box a visible-set computation reads, as typed arrays.
 *
 * `visibleFrom`'s first cut walked the map through `getStack` — three string
 * builds and three hash lookups per cell — and spent 43 of its 59 milliseconds
 * in the flood doing exactly that. This is the fix the notes already prescribe
 * (*Typed arrays, not string-keyed Maps, in hot loops*), applied to the same
 * shape `DenseOcclusion` uses in `app/lib/lighting.ts`: read the box once into
 * flat arrays, then flood and ray against integer indices.
 *
 * Two numbers per cell and that is the whole of what looking needs:
 *
 * - `blockH` — how tall the solid part of the cell stands, in a tile's own
 *   height units. What stops a look sideways. 0 means nothing solid, which is
 *   also what an absent cell reads as.
 * - `sealed` — whether the cell's ground stops a look passing vertically. What
 *   makes a floor a floor and a hole a hole.
 *
 * `present` is beside them for a different reason: it says whether the map has
 * anything here at all, which is what decides whether a cell is worth *sending*
 * as opposed to worth looking through.
 */
import { getChunk, chunkKeyAt, chunkIndexOf } from "../lib/mapData";
import { stackBlockHeight, stackOcclusion } from "../lib/lighting";
import { parseCoordKey, type MapFile, type TileDef } from "../lib/types";

export class SightField {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly blockH: Int16Array;
  readonly sealed: Uint8Array;
  readonly present: Uint8Array;
  /** Cells the fill actually wrote, for the bench. */
  readonly filled: number;

  constructor(
    map: MapFile,
    tilesById: Record<string, TileDef>,
    x0: number,
    y0: number,
    z0: number,
    w: number,
    h: number,
    d: number,
  ) {
    this.x0 = x0;
    this.y0 = y0;
    this.z0 = z0;
    this.w = w;
    this.h = h;
    this.d = d;
    const size = w * h * d;
    this.blockH = new Int16Array(size);
    this.sealed = new Uint8Array(size);
    this.present = new Uint8Array(size);

    let filled = 0;
    const cx0 = chunkIndexOf(x0);
    const cx1 = chunkIndexOf(x0 + w - 1);
    const cy0 = chunkIndexOf(y0);
    const cy1 = chunkIndexOf(y0 + h - 1);
    for (let dz = 0; dz < d; dz++) {
      const z = z0 + dz;
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          // Only the chunks the box overlaps, and only the cells they hold —
          // so a box over open country costs its handful of misses rather than
          // a walk of every position in it.
          const cells = getChunk(map, z, chunkKeyAt(cx, cy));
          if (!cells) continue;
          for (const key in cells) {
            const { x, y } = parseCoordKey(key);
            const ix = x - x0;
            const iy = y - y0;
            if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
            const stack = cells[key]!;
            const at = (dz * h + iy) * w + ix;
            this.blockH[at] = stackBlockHeight(stack, tilesById);
            this.sealed[at] = stackOcclusion(stack, tilesById).sealsLevel ? 1 : 0;
            this.present[at] = 1;
            filled++;
          }
        }
      }
    }
    this.filled = filled;
  }

  /** Index of a world cell, or -1 when it is outside the box. */
  at(x: number, y: number, z: number): number {
    const ix = x - this.x0;
    const iy = y - this.y0;
    const iz = z - this.z0;
    if (ix < 0 || iy < 0 || iz < 0) return -1;
    if (ix >= this.w || iy >= this.h || iz >= this.d) return -1;
    return (iz * this.h + iy) * this.w + ix;
  }
}
