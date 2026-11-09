import { chunkKeyAt } from "../lib/mapData";
import { CHUNK_SIZE, levelKey } from "../lib/types";
import type { MapFile } from "../lib/types";
import type { WorldRect } from "../lib/lightingChunks";
import { type LevelRange, MESH_WINDOW_MARGIN } from "../lib/view";
import { REFLECTION_REACH_CELLS } from "./reflections";

/** The camera's rect on level 0, and the levels drawn through it. */
export type MeshWindow = WorldRect & { levels: LevelRange };

export { MESH_WINDOW_MARGIN } from "../lib/view";

/**
 * How far past the window a chunk is built in the frame it is first wanted.
 * Art stands up to `REFLECTION_REACH_CELLS` above its own cell, so a chunk
 * this near can already be drawn into the view. The rest of
 * `MESH_WINDOW_MARGIN` is warning, and is built a few chunks a frame.
 */
export const MESH_BUILD_NOW_MARGIN = REFLECTION_REACH_CELLS;

export type ChunkAddress = { z: number; chunk: string };

export function chunkAddressKey(z: number, chunk: string): string {
  return `${z}:${chunk}`;
}

function levelRect(window: WorldRect, z: number, margin = MESH_WINDOW_MARGIN): WorldRect {
  return {
    x0: window.x0 + z - margin,
    y0: window.y0 + z - margin,
    x1: window.x1 + z + margin,
    y1: window.y1 + z + margin,
  };
}

export function cellInMeshWindow(window: MeshWindow, x: number, y: number, z: number): boolean {
  if (z < window.levels.z0 || z > window.levels.z1) return false;
  const rect = levelRect(window, z);
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

export function visibleChunkKeys(
  map: MapFile,
  window: MeshWindow,
  margin = MESH_WINDOW_MARGIN,
): Set<string> {
  const wanted = new Set<string>();
  for (let z = window.levels.z0; z <= window.levels.z1; z++) {
    const level = map.levels[levelKey(z)];
    if (level === undefined) continue;

    const rect = levelRect(window, z, margin);
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

export function parseChunkAddress(key: string): ChunkAddress {
  const at = key.indexOf(":");
  return { z: Number(key.slice(0, at)), chunk: key.slice(at + 1) };
}
