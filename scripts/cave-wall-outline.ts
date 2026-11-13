import { E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE } from "../app/lib/types";

const CELL = CELL_SIZE;
const HALF = CELL / 2;
const RIDGE = CELL / 4;

/**
 * How much wider than a cave wall's a hill wall's outline is at the ceiling.
 * `generate-brinks.ts` cuts the ground to the same outline, so a body on the
 * edge of a hill has this much more grass under it.
 */
export const HILL_CROWN = 2;

export type Point = { x: number; y: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * A quarter of the cell is rock only when all three neighbours around its
 * corner are, so every face of a solid mass sits on a cell's half line and a
 * passage one cell wide is drawn two wide. Indexed so that `i ^ 1` and `i ^ 2`
 * are the quarters beside quarter `i`, and `i ^ 3` the one across from it.
 */
const QUADRANTS: { needs: number; corner: Point; square: Rect }[] = [
  { needs: N | NW | W, corner: { x: 0, y: 0 }, square: { x0: 0, y0: 0, x1: HALF, y1: HALF } },
  { needs: N | NE | E, corner: { x: CELL, y: 0 }, square: { x0: HALF, y0: 0, x1: CELL, y1: HALF } },
  { needs: S | SW | W, corner: { x: 0, y: CELL }, square: { x0: 0, y0: HALF, x1: HALF, y1: CELL } },
  {
    needs: S | SE | E,
    corner: { x: CELL, y: CELL },
    square: { x0: HALF, y0: HALF, x1: CELL, y1: CELL },
  },
];

/**
 * Rock with open ground on both sides would get no quarter at all, so it is
 * drawn as a ridge half a cell thick toward each rock neighbour. A ridge beside
 * a filled quarter is left out, or it would stick past that quarter's face.
 * `flanks` are the edges a ridge runs alongside, each with the quarter at its
 * far end.
 */
const RIDGES: {
  side: number;
  beside: readonly [number, number];
  rect: Rect;
  flanks: readonly { edge: number; quadrant: number }[];
}[] = [
  {
    side: N,
    beside: [0, 1],
    rect: { x0: HALF - RIDGE, y0: 0, x1: HALF + RIDGE, y1: HALF },
    flanks: [
      { edge: W, quadrant: 2 },
      { edge: E, quadrant: 3 },
    ],
  },
  {
    side: E,
    beside: [1, 3],
    rect: { x0: HALF, y0: HALF - RIDGE, x1: CELL, y1: HALF + RIDGE },
    flanks: [
      { edge: N, quadrant: 0 },
      { edge: S, quadrant: 2 },
    ],
  },
  {
    side: S,
    beside: [2, 3],
    rect: { x0: HALF - RIDGE, y0: HALF, x1: HALF + RIDGE, y1: CELL },
    flanks: [
      { edge: W, quadrant: 0 },
      { edge: E, quadrant: 1 },
    ],
  },
  {
    side: W,
    beside: [0, 2],
    rect: { x0: 0, y0: HALF - RIDGE, x1: HALF, y1: HALF + RIDGE },
    flanks: [
      { edge: N, quadrant: 1 },
      { edge: S, quadrant: 3 },
    ],
  },
];

/**
 * The inside corners where a ridge meets another ridge, or the face of a filled
 * quarter, each rounded by a circle centred here. Every one stays two pixels in
 * from the cell's edge, where the outline has to meet the neighbouring slice.
 */
const FILLETS: { ridges: number; quadrant?: number; centre: Point }[] = [
  { ridges: N | W, centre: { x: 0, y: 0 } },
  { ridges: N | E, centre: { x: CELL, y: 0 } },
  { ridges: S | W, centre: { x: 0, y: CELL } },
  { ridges: S | E, centre: { x: CELL, y: CELL } },
  { ridges: N, quadrant: 2, centre: { x: 0, y: HALF - RIDGE } },
  { ridges: N, quadrant: 3, centre: { x: CELL, y: HALF - RIDGE } },
  { ridges: S, quadrant: 0, centre: { x: 0, y: HALF + RIDGE } },
  { ridges: S, quadrant: 1, centre: { x: CELL, y: HALF + RIDGE } },
  { ridges: E, quadrant: 0, centre: { x: HALF + RIDGE, y: 0 } },
  { ridges: E, quadrant: 2, centre: { x: HALF + RIDGE, y: CELL } },
  { ridges: W, quadrant: 1, centre: { x: HALF - RIDGE, y: 0 } },
  { ridges: W, quadrant: 3, centre: { x: HALF - RIDGE, y: CELL } },
];

function inRect({ x0, y0, x1, y1 }: Rect, x: number, y: number): boolean {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

function distanceToRect({ x0, y0, x1, y1 }: Rect, x: number, y: number): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
}

/**
 * A corner of solid rock at the cell's centre becomes an arc centred on the cell
 * corner, half a cell across, which is the widest that meets both neighbouring
 * slices square on their half lines. Filled quarters on opposite corners stay
 * whole, so a rock cell between two diagonal pockets does not read as open.
 * Widening by `grow` pushes each face out, grows each arc and shrinks each
 * pocket, all about the same cell corners, so every edge still depends only on
 * the two quarters the neighbouring slice shares.
 */
function quadrantRock(filled: boolean[], x: number, y: number, grow: number): boolean {
  return QUADRANTS.some(({ corner, square }, i) => {
    const fromCorner = Math.hypot(x - corner.x, y - corner.y);
    if (!filled[i]) {
      return filled[i ^ 1]! && filled[i ^ 2]! && inRect(square, x, y) && fromCorner >= HALF - grow;
    }
    if (filled[i ^ 1] || filled[i ^ 2] || filled[i ^ 3]) {
      return inRect(square, x, y) || distanceToRect(square, x, y) < grow;
    }
    return fromCorner < HALF + grow;
  });
}

/** The corner a fillet rounds is its radius from its centre, toward the cell's middle. */
function inFillet(centre: Point, radius: number, x: number, y: number): boolean {
  const corner = {
    x0: centre.x,
    y0: centre.y,
    x1: centre.x + Math.sign(HALF - centre.x) * radius,
    y1: centre.y + Math.sign(HALF - centre.y) * radius,
  };
  const inCorner =
    x >= Math.min(corner.x0, corner.x1) &&
    x < Math.max(corner.x0, corner.x1) &&
    y >= Math.min(corner.y0, corner.y1) &&
    y < Math.max(corner.y0, corner.y1);
  return inCorner && Math.hypot(x - centre.x, y - centre.y) >= radius;
}

/**
 * A ridge widened by `grow` on both sides. Where it runs beside an edge whose
 * neighbour shows only the face of the quarter at that edge's far end, it stops
 * a pixel short of the edge: that neighbour cannot see the ridge, so rock there
 * would meet nothing on the other side.
 */
function ridgeRect(ridge: (typeof RIDGES)[number], mask: number, filled: boolean[], grow: number) {
  const along = ridge.side === N || ridge.side === S;
  const rect = along
    ? { ...ridge.rect, x0: ridge.rect.x0 - grow, x1: ridge.rect.x1 + grow }
    : { ...ridge.rect, y0: ridge.rect.y0 - grow, y1: ridge.rect.y1 + grow };
  for (const { edge, quadrant } of ridge.flanks) {
    if ((mask & edge) === 0 || !filled[quadrant]) continue;
    if (edge === W) rect.x0 = Math.max(rect.x0, 1);
    if (edge === E) rect.x1 = Math.min(rect.x1, CELL - 1);
    if (edge === N) rect.y0 = Math.max(rect.y0, 1);
    if (edge === S) rect.y1 = Math.min(rect.y1, CELL - 1);
  }
  return rect;
}

function outline(mask: number, grow: number, thicken: number): (x: number, y: number) => boolean {
  const filled = QUADRANTS.map(({ needs }) => (mask & needs) === needs);
  const ridges = RIDGES.filter(
    ({ side, beside }) => (mask & side) !== 0 && !filled[beside[0]] && !filled[beside[1]],
  );
  /**
   * A ridge, and the disc at the centre where ridges meet, are widened by
   * `thicken`, not by `grow`. They stand half as far from the cell's edge as a
   * face does, so they widen at half the rate and every slope reaches the edge
   * at the floor. The disc is all there is of a cell with no rock beside it.
   */
  const rects = ridges.map((ridge) => ridgeRect(ridge, mask, filled, thicken));
  const ridgeSides = ridges.reduce((sides, { side }) => sides | side, 0);
  const hub = ridges.length > 0 || !filled.some(Boolean);
  const filletRadius = RIDGE - thicken;
  const fillets = FILLETS.filter(
    (f) =>
      filletRadius > 0 &&
      (ridgeSides & f.ridges) === f.ridges &&
      (f.quadrant === undefined || filled[f.quadrant]),
  );
  return (x, y) =>
    quadrantRock(filled, x, y, grow) ||
    rects.some((rect) => inRect(rect, x, y)) ||
    (hub && Math.hypot(x - HALF, y - HALF) < RIDGE + thicken) ||
    fillets.some(({ centre }) => inFillet(centre, filletRadius, x, y));
}

/**
 * Around a cell corner whose four cells are not all rock, two of the slices
 * that meet there may not see each other, and each would widen toward the
 * corner from a different ridge or face. Keeping the pixel at that corner empty
 * until the floor, where every slope reaches it, is the one answer both give.
 */
export function footprint(mask: number, grow = 0, thicken = grow / 2): boolean[][] {
  const rock = outline(mask, grow, thicken);
  const grid = Array.from({ length: CELL }, (_, row) =>
    Array.from({ length: CELL }, (_, col) => rock(col + 0.5, row + 0.5)),
  );
  if (grow < HALF) {
    QUADRANTS.forEach(({ needs, corner }) => {
      if ((mask & needs) !== needs) {
        grid[Math.min(corner.y, CELL - 1)]![Math.min(corner.x, CELL - 1)] = false;
      }
    });
  }
  return grid;
}
