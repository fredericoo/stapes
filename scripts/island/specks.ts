import {
  COVER_TILES,
  KIND_OF_BASE,
  MIN_PATCH_CELLS,
  MIN_SNOW_PATCH_CELLS,
  WATER_TILES,
  type Kind,
} from "../../app/verify/landscape";
import { tile, type Board } from "./board";
import { N4, N8 } from "./grid";
import { forNeighbours, shoreOf } from "./stacks";
import type { Island } from "./terrain";

const FULL: Record<Kind, string> = { grass: "grass-2", snow: "snow", sand: "sand-dunes" };
const BRINK: Record<Kind, string> = {
  grass: "grass-brink",
  snow: "snow-brink",
  sand: "sand-brink",
};

/**
 * The ground on top of each column, by the same reading `verify landscape`
 * makes of the map: its kind, and whether it shows or has mud, a street or a
 * floor over it. Water has no ground.
 */
function groundKinds(island: Island, board: Board) {
  const { width: w, height: h, level } = island;
  const kinds = new Array<Kind | null>(w * h).fill(null);
  const open = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const stack = board.get(i % w, Math.floor(i / w), level[i]!);
    const kind = stack?.[0] ? KIND_OF_BASE[stack[0].tileId] : undefined;
    if (!kind || stack!.some((p) => WATER_TILES.has(p.tileId))) continue;
    kinds[i] = kind;
    if (!stack!.some((p) => COVER_TILES.has(p.tileId))) open[i] = 1;
  }
  return { kinds, open };
}

/**
 * Gives every piece of ground smaller than `MIN_PATCH_CELLS` (for snow,
 * `MIN_SNOW_PATCH_CELLS`) the ground
 * most of the ground round it has. A piece starts on ground that shows and
 * runs on under any cover of the same ground, as `verify landscape` counts it. Seams `harmoniseGround` moved
 * and grounds spilled from a site leave such specks after the terrain's own
 * pass. A piece on a shore is a beach and is left alone, and so is a bank
 * of water laid on the same ground, which `harmoniseGround` would only give
 * back its ground. Returns how many cells changed.
 */
export function mergeSpecks(island: Island, board: Board): number {
  const { width: w, height: h, level } = island;
  const { kinds, open } = groundKinds(island, board);
  const seen = new Uint8Array(w * h);
  const shore = shoreOf(island);
  let changed = 0;
  for (let start = 0; start < w * h; start++) {
    const kind = kinds[start];
    if (!kind || !open[start] || seen[start]) continue;
    const piece = flood(island, kinds, seen, start);
    const least = kind === "snow" ? MIN_SNOW_PATCH_CELLS : MIN_PATCH_CELLS;
    if (piece.length >= least || byShore(island, shore, piece)) continue;
    if (banksOwnWater(island, board, piece, kind)) continue;
    const into = mostAround(island, kinds, piece, kind);
    if (!into) continue;
    for (const i of piece) {
      const stack = board.get(i % w, Math.floor(i / w), level[i]!)!;
      const brink = stack[0]!.tileId === BRINK[kind];
      stack[0] = tile(brink ? BRINK[into] : FULL[into]);
      changed++;
    }
  }
  return changed;
}

function flood(island: Island, kinds: Array<Kind | null>, seen: Uint8Array, start: number) {
  const { width: w, height: h } = island;
  const piece = [start];
  seen[start] = 1;
  for (let k = 0; k < piece.length; k++) {
    const i = piece[k]!;
    forNeighbours(w, h, i, N4, (j) => {
      if (seen[j] || kinds[j] !== kinds[start]) return;
      seen[j] = 1;
      piece.push(j);
    });
  }
  return piece;
}

function banksOwnWater(island: Island, board: Board, piece: number[], kind: Kind): boolean {
  const { width: w, height: h, level } = island;
  return piece.some((i) => {
    let banks = false;
    forNeighbours(w, h, i, N8, (j) => {
      if (level[j] !== level[i]) return;
      const stack = board.get(j % w, Math.floor(j / w), level[j]!);
      const wet = !!stack?.some((p) => WATER_TILES.has(p.tileId));
      if (wet && KIND_OF_BASE[stack![0]!.tileId] === kind) banks = true;
    });
    return banks;
  });
}

function byShore(island: Island, shore: Uint8Array, piece: number[]): boolean {
  const { width: w, height: h } = island;
  return piece.some((i) => {
    let wet = false;
    forNeighbours(w, h, i, N8, (j) => {
      if (shore[j]) wet = true;
    });
    return wet;
  });
}

function mostAround(
  island: Island,
  kinds: Array<Kind | null>,
  piece: number[],
  kind: Kind,
): Kind | null {
  const { width: w, height: h } = island;
  const counts = new Map<Kind, number>();
  for (const i of piece) {
    forNeighbours(w, h, i, N4, (j) => {
      const other = kinds[j];
      if (other && other !== kind) counts.set(other, (counts.get(other) ?? 0) + 1);
    });
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
