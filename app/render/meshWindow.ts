import { chunkKeyAt } from "../lib/mapData";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL, levelKey } from "../lib/types";
import type { MapFile } from "../lib/types";
import type { WorldRect } from "../lib/lightingChunks";
import { MESH_WINDOW_MARGIN } from "../lib/view";

export { MESH_WINDOW_MARGIN } from "../lib/view";

export type ChunkAddress = { z: number; chunk: string };

export function chunkAddressKey(z: number, chunk: string): string {
  return `${z}:${chunk}`;
}

function levelRect(window: WorldRect, z: number): WorldRect {
  return {
    x0: window.x0 + z - MESH_WINDOW_MARGIN,
    y0: window.y0 + z - MESH_WINDOW_MARGIN,
    x1: window.x1 + z + MESH_WINDOW_MARGIN,
    y1: window.y1 + z + MESH_WINDOW_MARGIN,
  };
}

export function cellInMeshWindow(window: WorldRect, x: number, y: number, z: number): boolean {
  const rect = levelRect(window, z);
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

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

export function parseChunkAddress(key: string): ChunkAddress {
  const at = key.indexOf(":");
  return { z: Number(key.slice(0, at)), chunk: key.slice(at + 1) };
}
