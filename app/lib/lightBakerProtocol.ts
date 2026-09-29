import type { ChunkCells, MapFile, TileDef } from "./types";
import type { WorldRect } from "./lightingChunks";

export type MapPatch = {
  levels: Record<string, Record<string, ChunkCells | null> | null>;
};

export type BakerRequest =
  | { type: "init"; tiles: TileDef[]; omit: string[]; map: MapFile }
  | { type: "patch"; patch: MapPatch }
  | { type: "bake"; id: number; rect: WorldRect; timeMs: number };

export type WirePlanes = Array<[number, Uint8Array]>;

export type WireChunk = {
  planes: WirePlanes;
  animated: string[];
};

export type BakerResponse =
  | { type: "baked"; id: number; chunks: Array<[string, WireChunk]> }
  | { type: "failed"; id: number; message: string };

/**
 * Sending the map slice a bake needs costs about 3ms of structured clone on
 * the calling thread — a third of the bake it was meant to save — so the
 * worker keeps its own copy of the map instead and is only ever told what
 * changed. `MapFile` is persistent (an edit rebuilds only the level and
 * chunk it touched), so a reference compare here cannot miss a change.
 */
export function diffMapChunks(prev: MapFile | null, next: MapFile): MapPatch | null {
  if (prev === next) return null;
  const levels: MapPatch["levels"] = {};
  let any = false;

  for (const lz of Object.keys(next.levels)) {
    const before = prev?.levels[lz];
    const after = next.levels[lz]!;
    if (before === after) continue;
    const chunks: Record<string, ChunkCells | null> = {};
    for (const ck of Object.keys(after)) {
      if (before?.[ck] === after[ck]) continue;
      chunks[ck] = after[ck]!;
      any = true;
    }
    for (const ck of Object.keys(before ?? {})) {
      if (after[ck] !== undefined) continue;
      chunks[ck] = null;
      any = true;
    }
    if (Object.keys(chunks).length) levels[lz] = chunks;
  }

  for (const lz of Object.keys(prev?.levels ?? {})) {
    if (next.levels[lz] !== undefined) continue;
    levels[lz] = null;
    any = true;
  }

  return any ? { levels } : null;
}

export function applyMapPatch(map: MapFile, patch: MapPatch) {
  for (const [lz, chunks] of Object.entries(patch.levels)) {
    if (chunks === null) {
      delete map.levels[lz];
      continue;
    }
    const level = (map.levels[lz] ??= {});
    for (const [ck, cells] of Object.entries(chunks)) {
      if (cells === null) delete level[ck];
      else level[ck] = cells;
    }
  }
}
