import type { StackEdit } from "../../lib/mapData";
import { HEIGHT_PER_LEVEL, type PlacedTile } from "../../lib/types";

/**
 * A tree that stands over several levels: its base, a level tall, then
 * `trunks` of its trunk one on another, and its crown on top. The trunks and
 * crown start on the level above the base and carry on to the next level
 * whenever one fills, so the crown is always on a level of its own above the
 * base and the roof-cut can lift it off a player (`TileDef.cutAlone`).
 */
export type TallTree = {
  trunk: string;
  crown: string;
  trunks: { min: number; max: number };
};

export const TALL_TREES: Readonly<Record<string, TallTree>> = {
  "old-tree": { trunk: "old-tree-trunk", crown: "old-tree-crown", trunks: { min: 0, max: 3 } },
};

const UINT32 = 4294967296;

/** The trunks and crown of a tree with `trunks` trunks, one stack per level from the level above the base. */
function stackPieces(
  tree: TallTree,
  trunks: number,
  heightOf: (tileId: string) => number,
): PlacedTile[][] {
  const levels: PlacedTile[][] = [[]];
  let used = 0;
  for (const tileId of [...Array<string>(trunks).fill(tree.trunk), tree.crown]) {
    const height = heightOf(tileId);
    if (used > 0 && used + height > HEIGHT_PER_LEVEL) {
      levels.push([]);
      used = 0;
    }
    levels.at(-1)!.push({ tileId });
    used += height;
  }
  return levels;
}

/**
 * The trunks and crown to stand on a base at level `z`, one stack per level
 * from `z + 1` up: as many trunks as `hash`, a uniform 32-bit number, picks
 * between the tree's least and most, fewer where a level they would reach is
 * not empty, and null where not even the least fits.
 */
export function growTallTree(
  tree: TallTree,
  hash: number,
  heightOf: (tileId: string) => number,
  emptyAt: (z: number) => boolean,
  z: number,
): PlacedTile[][] | null {
  const { min, max } = tree.trunks;
  const want = min + Math.min(max - min, Math.floor((hash / UINT32) * (max - min + 1)));
  for (let trunks = want; trunks >= min; trunks--) {
    const levels = stackPieces(tree, trunks, heightOf);
    if (levels.every((_, i) => emptyAt(z + i + 1))) return levels;
  }
  return null;
}

const PIECES = new Set(Object.values(TALL_TREES).flatMap((t) => [t.trunk, t.crown]));

/** Whether `tileId` is a tall tree's trunk or crown, which stands on its base rather than on a level of its own. */
export function isTallTreePiece(tileId: string): boolean {
  return PIECES.has(tileId);
}

/**
 * The edits that take a tall tree's trunks and crown off the levels above
 * wherever `edits` took its base away, so a road, a clearing or a hill that
 * removes a tree does not leave the rest of it in the air. `before` reads
 * the map the edits were made against and `after` the map they made.
 */
export function fellAbove(
  edits: readonly StackEdit[],
  before: (x: number, y: number, z: number) => readonly PlacedTile[],
  after: (x: number, y: number, z: number) => readonly PlacedTile[],
): StackEdit[] {
  const out: StackEdit[] = [];
  for (const e of edits) {
    for (const base of before(e.x, e.y, e.z)) {
      const tree = TALL_TREES[base.tileId];
      if (!tree || e.stack.some((p) => p.tileId === base.tileId)) continue;
      const pieces = new Set([tree.trunk, tree.crown]);
      for (let z = e.z + 1; ; z++) {
        const stack = after(e.x, e.y, z);
        const kept = stack.filter((p) => !pieces.has(p.tileId));
        if (kept.length === stack.length) break;
        out.push({ x: e.x, y: e.y, z, stack: kept });
      }
    }
  }
  return out;
}
