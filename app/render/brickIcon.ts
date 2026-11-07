export type Cell = { x: number; y: number };

const OUTLINE_BRICKS = 1;

export function filledCells(pixels: readonly string[], filled: (pixel: string) => boolean): Cell[] {
  const cells: Cell[] = [];
  for (const [y, row] of pixels.entries()) {
    for (const [x, pixel] of [...row].entries()) {
      if (filled(pixel)) cells.push({ x, y });
    }
  }
  return cells;
}

function cellsAround(cell: Cell): Cell[] {
  const around: Cell[] = [];
  for (let dy = -OUTLINE_BRICKS; dy <= OUTLINE_BRICKS; dy++) {
    for (let dx = -OUTLINE_BRICKS; dx <= OUTLINE_BRICKS; dx++) {
      around.push({ x: cell.x + dx, y: cell.y + dy });
    }
  }
  return around;
}

/** Every cell within one brick of a filled one, corners included, that is not itself filled. */
export function outlineCells(cells: readonly Cell[]): Cell[] {
  const key = (cell: Cell) => `${cell.x},${cell.y}`;
  const taken = new Set(cells.map(key));
  const outline = new Map<string, Cell>();
  for (const cell of cells) {
    for (const around of cellsAround(cell)) {
      if (!taken.has(key(around))) outline.set(key(around), around);
    }
  }
  return [...outline.values()];
}
