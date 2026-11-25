import { E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE } from "../app/lib/types";

/**
 * The outline of a tile that fills the cells it joins and stops short of the
 * ones it does not, with every corner rounded: the outline an autotile with a
 * full 256-mask sheet (`autotileMask: "full"`) draws.
 *
 * - `inset`: how far the outline stays from the cells it does not join along
 *   a straight side, in art pixels.
 * - `outerRound`: the corner radius of each cell it does not join, which
 *   rounds the tile's inner corners (a headland of land is round at its tip).
 * - `blend`: how far apart two of those cells can be and still be joined by a
 *   fillet, which rounds the tile's own outer corners.
 */
export type RoundedEdge = { inset: number; outerRound: number; blend: number };

const SUPERSAMPLE = 4;
/** Cells either side of the centre that the outline is measured against. */
const REACH = 2;
const FAR = 1e9;

const BITS: Record<string, number> = {
  "0,-1": N,
  "1,-1": NE,
  "1,0": E,
  "1,1": SE,
  "0,1": S,
  "-1,1": SW,
  "-1,0": W,
  "-1,-1": NW,
};

export type Joined = (dx: number, dy: number) => boolean;

/**
 * Whether the tile is in the cell `dx, dy` from the centre, for a centre cell
 * holding it with neighbour mask `mask`. Beyond the eight neighbours the
 * nearest of them is repeated; `masksReadingTooFar` checks that no outline
 * reads that far.
 */
export function joinedByMask(mask: number): Joined {
  return (dx, dy) => {
    const cx = Math.max(-1, Math.min(1, dx));
    const cy = Math.max(-1, Math.min(1, dy));
    if (cx === 0 && cy === 0) return true;
    return (mask & BITS[`${cx},${cy}`]!) !== 0;
  };
}

/** Signed distance from `px, py` to a square of half-side `half` centred on the origin, its corners rounded to `radius`. */
function roundedSquare(px: number, py: number, half: number, radius: number): number {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Polynomial smooth minimum folded over the distances in ascending order. A
 * value at least `blend` above the running minimum changes nothing, which is
 * what keeps a cell further away than that out of the outline.
 */
function smoothMin(values: number[], blend: number): number {
  values.sort((a, b) => a - b);
  let out = values[0] ?? FAR;
  for (let i = 1; i < values.length; i++) {
    const h = Math.max(blend - Math.abs(out - values[i]!), 0) / blend;
    out = Math.min(out, values[i]!) - (h * h * blend) / 4;
  }
  return out;
}

/** Distance from a point, in art pixels from the centre cell's top-left corner, to the rounded union of the cells the tile does not join. */
export function clearanceAt(joined: Joined, edge: RoundedEdge, px: number, py: number): number {
  const half = CELL_SIZE / 2;
  const distances: number[] = [];
  for (let dy = -REACH; dy <= REACH; dy++) {
    for (let dx = -REACH; dx <= REACH; dx++) {
      if (joined(dx, dy)) continue;
      const cx = dx * CELL_SIZE + half;
      const cy = dy * CELL_SIZE + half;
      distances.push(roundedSquare(px - cx, py - cy, half, edge.outerRound));
    }
  }
  return smoothMin(distances, edge.blend);
}

/**
 * Coverage of each art pixel of the centre cell, 0 to 1, row by row: the
 * share of its samples at least `edge.inset + offset` from the cells the tile
 * does not join. A negative `offset` grows the outline towards them; a
 * function gives the offset at each point, in art pixels from the cell's
 * top-left corner.
 */
export function outlineCoverage(
  joined: Joined,
  edge: RoundedEdge,
  offset: number | ((px: number, py: number) => number) = 0,
): number[][] {
  const offsetAt = typeof offset === "number" ? () => offset : offset;
  return Array.from({ length: CELL_SIZE }, (_, y) =>
    Array.from({ length: CELL_SIZE }, (_, x) => {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;
          if (clearanceAt(joined, edge, px, py) >= edge.inset + offsetAt(px, py)) hits++;
        }
      }
      return hits / (SUPERSAMPLE * SUPERSAMPLE);
    }),
  );
}

/**
 * The masks whose centre-cell outline changes with what lies past the eight
 * neighbours. A sheet with one row per mask tiles without a seam only when
 * this is empty for every offset it draws.
 */
export function masksReadingTooFar(edge: RoundedEdge, offsets: number[] = [0]): number[] {
  const bad: number[] = [];
  const pixels = (joined: Joined, offset: number) =>
    outlineCoverage(joined, edge, offset)
      .map((row) => row.map((c) => (c >= 0.5 ? 1 : 0)).join(""))
      .join("/");
  for (let mask = 0; mask < 256; mask++) {
    const near = joinedByMask(mask);
    const ring =
      (far: Joined): Joined =>
      (dx, dy) =>
        Math.abs(dx) <= 1 && Math.abs(dy) <= 1 ? near(dx, dy) : far(dx, dy);
    const rings = [
      ring(() => true),
      ring(() => false),
      ring((dx, dy) => (dx + dy) % 2 === 0),
      ring((dx, dy) => (dx * 7 + dy * 3) % 3 === 0),
    ];
    const differs = offsets.some((offset) => {
      const expected = pixels(near, offset);
      return rings.some((r) => pixels(r, offset) !== expected);
    });
    if (differs) bad.push(mask);
  }
  return bad;
}
