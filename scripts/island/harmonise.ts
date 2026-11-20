import type { PlacedTile, TileDef } from "../../app/lib/types";
import type { Board } from "./board";
import { N8 } from "./grid";

const FULL_GROUND = new Set(["grass-2", "sand", "snow"]);
const SEAMED = new Set([
  "dirt",
  "water",
  "basalt",
  "mud",
  "flagstone-floor",
  "moss-flagstone",
  "cobblestone",
  "wooden-floor",
]);
const PASSES = 40;
/** Covers that may be lifted off a cell left on a seam, last first: a road first, then bare mud or lava rock, which only thin a bank or a lava field. */
const CUTS = [new Set(["dirt"]), new Set(["dirt", "mud", "basalt"])];

/**
 * An autotile draws its edge towards a neighbour that holds neither it nor
 * anything it connects to, and the ground under it shows in that edge
 * (`docs/terrain.md`), so a line of the wrong ground shows wherever that
 * neighbour stands on another. Each pass gives every such plain neighbour
 * the autotile's ground, or, where the neighbour is an autotile itself,
 * takes the neighbour's ground, which moves the line between two grounds
 * out into open ground where nothing draws an edge across it. Returns how
 * many seams are left.
 */
export function harmoniseGround(board: Board, tilesById: Record<string, TileDef>): number {
  let left = settle(board, tilesById, new Set());
  for (const cut of CUTS) if (left) left = settle(board, tilesById, cut);
  return left;
}

/** A cell still on a seam whose only cover is in `cut` loses it and stays bare ground, which draws no edge. */
function settle(board: Board, tilesById: Record<string, TileDef>, cut: Set<string>): number {
  let left = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    left = 0;
    for (const [, layer] of board.levels) {
      for (const [i, stack] of layer) {
        const base = stack[0]?.tileId;
        const autoAt = stack.findIndex((p, k) => k > 0 && SEAMED.has(p.tileId));
        if (!base || autoAt !== 1 || !FULL_GROUND.has(base)) continue;
        const auto = stack[1]!.tileId;
        const joins = new Set([auto, ...(tilesById[auto]?.connectsTo ?? [])]);
        const x = i % board.width;
        const y = (i - x) / board.width;
        for (const [dx, dy] of N8) {
          const other: PlacedTile[] | undefined = layer.get((y + dy) * board.width + x + dx);
          if (!other || other.some((p) => joins.has(p.tileId))) continue;
          const g = other[0]?.tileId;
          if (!g || !FULL_GROUND.has(g) || g === stack[0]!.tileId) continue;
          left++;
          if (cut.has(auto) && stack.length === 2) {
            stack.length = 1;
            break;
          }
          if (SEAMED.has(other[1]?.tileId ?? "")) stack[0] = { tileId: g };
          else other[0] = { tileId: stack[0]!.tileId };
        }
      }
    }
    if (left === 0) break;
  }
  return left;
}
