import { chunkifyMap } from "../../app/lib/mapData";
import type { TileDef } from "../../app/lib/types";
import { KIND_OF_BASE, checkLandscape, type Kind } from "../../app/verify/landscape";
import { tile, type Board } from "./board";
import type { Island } from "./terrain";

const FULL: Record<Kind, string> = { grass: "grass-2", snow: "snow", sand: "sand" };
/** How many cells of the line's middle are pushed across it: two, so the jog reads as a step in the border and not a speck. */
const JOG_CELLS = 2;

/**
 * Breaks every border `verify landscape` finds running straight for too
 * long: the cells at the middle of the line, on its first side, take the
 * ground of the second, so the border steps there. A straight road pulls the
 * seam beside it straight as `harmoniseGround` settles it, and nothing else
 * in the ground loop would bend it again. Returns how many cells changed.
 */
export function jogStraightBorders(
  island: Island,
  board: Board,
  tilesById: Record<string, TileDef>,
): number {
  const map = chunkifyMap(board.toFlat());
  const { problems } = checkLandscape({ map, tilesById });
  let changed = 0;
  for (const p of problems) {
    if (!p.run) continue;
    const across = { x: p.run.dy, y: p.run.dx };
    const middle = Math.floor((p.run.cells - JOG_CELLS) / 2);
    for (let k = middle; k < middle + JOG_CELLS; k++) {
      const x = p.x + p.run.dx * k - board.ox;
      const y = p.y + p.run.dy * k - board.oy;
      changed += takeGround(island, board, x, y, x + across.x, y + across.y);
    }
  }
  return changed;
}

/** Gives the bare cell at `x`, `y` the ground of the cell at `fx`, `fy`, when both are plain ground on one level. */
function takeGround(island: Island, board: Board, x: number, y: number, fx: number, fy: number) {
  const z = island.level[y * island.width + x]!;
  if (island.level[fy * island.width + fx] !== z) return 0;
  const stack = board.get(x, y, z);
  const from = board.get(fx, fy, z)?.[0]?.tileId;
  const into = from ? KIND_OF_BASE[from] : undefined;
  if (!stack || stack.length !== 1 || !into || !KIND_OF_BASE[stack[0]!.tileId]) return 0;
  if (stack[0]!.tileId === FULL[into]) return 0;
  stack[0] = tile(FULL[into]);
  return 1;
}
