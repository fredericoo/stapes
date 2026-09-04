/**
 * Which of the map's chunks are worth turning into geometry.
 *
 * The renderer used to build every cell of every level the moment it had a
 * map, and rebuild a whole level whenever one of its chunks changed. That is a
 * cost proportional to the *world*: the animal den took the board from 20,887
 * cells to 44,160, and every one of them was meshed for a player who can see
 * 23 cells across.
 *
 * A player can only ever see {@link VIEW_CELLS} of world, and that is a
 * guarantee rather than a happy accident — the viewport is a fixed square on
 * every device. So the answer to "what has to exist as geometry" is a window,
 * and the map is already stored in `CHUNK_SIZE` squares, which makes the
 * window's unit the chunk: a chunk is what copy-on-write gives identity to, so
 * "has this changed" is a reference compare, and a chunk that scrolls off is a
 * group to dispose rather than a filter to re-run.
 *
 * **The unit is the chunk here and the cell on the wire, and those are not in
 * tension.** What the wire pays for a chunk is bytes crossing a network at the
 * moment you step over a boundary; what the renderer pays is a build it was
 * going to do anyway, of cells it already holds, and it can do it a chunk at a
 * time across frames. The costs are different, so the right quantum is
 * different.
 */
import { chunkKeyAt } from "../lib/mapData";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL, levelKey } from "../lib/types";
import type { MapFile } from "../lib/types";
import type { WorldRect } from "../lib/lightingChunks";

/**
 * Cells of slack around the camera's own reach, before the rect is rounded out
 * to whole chunks.
 *
 * Two things need it and neither is a safety margin. A sprite is drawn from
 * its cell *upward*, so a four-high tile a few rows below the bottom edge still
 * paints inside it — the same reason `PARTICLE_WINDOW_MARGIN` exists, and the
 * same size, because a tall tile and a rising spark cover about the same
 * distance. And a chunk is built in the frame it comes into range, so the
 * margin is also how much warning that build gets: at 16 cells a chunk and a
 * margin of 6, a walker crosses into a new chunk column with most of a chunk
 * still to walk before any of it is on screen.
 */
export const MESH_WINDOW_MARGIN = 6;

/** A chunk of one level, as the renderer keys its geometry. */
export type ChunkAddress = { z: number; chunk: string };

/** How a chunk of a level is named in every index keyed by one. */
export function chunkAddressKey(z: number, chunk: string): string {
  return `${z}:${chunk}`;
}

/**
 * The cells of level `z` that a camera window at level 0 can reach.
 *
 * The projection shifts level `z` by exactly `z` cells, which is the one piece
 * of arithmetic under every window in the renderer — `lightWindow` unions the
 * whole level span onto the base rect because a light on any storey can reach
 * you, and `appendVisibleTileEmitters` takes one level's own shift because a
 * plume is on a known level. Geometry is the second kind: a level's mesh is
 * drawn where that level is, so it takes that level's shift and nothing wider.
 */
function levelRect(window: WorldRect, z: number): WorldRect {
  return {
    x0: window.x0 + z - MESH_WINDOW_MARGIN,
    y0: window.y0 + z - MESH_WINDOW_MARGIN,
    x1: window.x1 + z + MESH_WINDOW_MARGIN,
    y1: window.y1 + z + MESH_WINDOW_MARGIN,
  };
}

/**
 * Every chunk that has to exist as geometry for this window, as address keys.
 *
 * Only chunks the map actually has: the rect is rounded out to chunk bounds and
 * then each candidate is looked up, so a window over the sea costs a handful of
 * misses rather than a walk of the level. That is also what keeps the cost of
 * this proportional to the *window* rather than to the map, which is the whole
 * point of it — a level with fifty thousand cells in it is asked about the same
 * forty chunks as a level with five hundred.
 *
 * Levels are not culled, only their chunks. A cut roof still has to be built:
 * the cut is applied to geometry that already exists — as a group toggle for a
 * whole storey and a shader mask for part of one — and deciding it here would
 * mean rebuilding the level's meshes every time the player took a step under an
 * eave.
 */
export function visibleChunkKeys(map: MapFile, window: WorldRect): Set<string> {
  const wanted = new Set<string>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const level = map.levels[levelKey(z)];
    if (level === undefined) continue;

    const rect = levelRect(window, z);
    const cx0 = Math.floor(rect.x0 / CHUNK_SIZE);
    const cx1 = Math.floor(rect.x1 / CHUNK_SIZE);
    const cy0 = Math.floor(rect.y0 / CHUNK_SIZE);
    const cy1 = Math.floor(rect.y1 / CHUNK_SIZE);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const chunk = chunkKeyAt(cx, cy);
        if (level[chunk] === undefined) continue;
        wanted.add(chunkAddressKey(z, chunk));
      }
    }
  }
  return wanted;
}

/** Read an address key back into the level and chunk it names. */
export function parseChunkAddress(key: string): ChunkAddress {
  const at = key.indexOf(":");
  return { z: Number(key.slice(0, at)), chunk: key.slice(at + 1) };
}
