import type { PlacedTile } from "../../../lib/types";

export type Cell = { x: number; y: number };

const WATER_TILE_IDS = new Set(["water", "deep-water"]);

export function isWet(stack: readonly PlacedTile[]): boolean {
  return stack.some((p) => WATER_TILE_IDS.has(p.tileId));
}

/**
 * Steps one axis at a time, each time onto whichever of the two next cells
 * lies nearer the straight line from `a` to `b` (the smaller cross product), so
 * the result is four-connected and walkable without cutting a corner.
 */
export function lineCells(a: Cell, b: Cell): Cell[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let { x, y } = a;
  const cells: Cell[] = [{ x, y }];
  while (x !== b.x || y !== b.y) {
    const offX = Math.abs((x + sx - a.x) * dy - (y - a.y) * dx);
    const offY = Math.abs((x - a.x) * dy - (y + sy - a.y) * dx);
    if (x !== b.x && (y === b.y || offX <= offY)) x += sx;
    else y += sy;
    cells.push({ x, y });
  }
  return cells;
}

/** The offsets across a band `width` cells wide, centred on the line, with the odd cell on the positive side. */
export function bandOffsets(width: number): number[] {
  const from = -Math.floor((width - 1) / 2);
  return Array.from({ length: width }, (_, i) => from + i);
}

/** A band is widened across the line's longer axis, so a mostly east-west line widens north-south. */
export function across(a: Cell, b: Cell): Cell {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: 0, y: 1 } : { x: 1, y: 0 };
}
