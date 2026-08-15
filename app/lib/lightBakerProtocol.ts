/**
 * Wire format between the renderer and the light baking worker.
 *
 * The shape is dictated by one measurement: sending the map slice a bake needs
 * costs ~3ms of structured clone on the calling thread, which is a third of the
 * bake it was meant to get rid of. So the worker keeps its own copy of the map
 * and is told what changed, and a request carries nothing but a rect.
 *
 * That copy is the one thing here that can be wrong in a way nothing catches,
 * so the patch is derived from the same identity walk the light cache already
 * does: {@link MapFile} is persistent — an edit rebuilds only the level and the
 * chunk it touched — so "different object" is exactly "different content", and
 * a patch cannot silently miss an edit that a reference compare can see.
 */
import type { ChunkCells, MapFile, TileDef } from "./types";
import type { WorldRect } from "./lightingChunks";

/**
 * Chunks whose contents differ, by level. `null` means gone — a level or chunk
 * that the new map no longer has, which must be deleted rather than left
 * behind lighting a room that was demolished.
 */
export type MapPatch = {
  levels: Record<string, Record<string, ChunkCells | null> | null>;
};

export type BakerRequest =
  | { type: "init"; tiles: TileDef[]; omit: string[]; map: MapFile }
  | { type: "patch"; patch: MapPatch }
  | { type: "bake"; id: number; rect: WorldRect };

/** One chunk's planes, flattened for the wire: `[z, rgba]` per level. */
export type WirePlanes = Array<[number, Uint8Array]>;

export type BakerResponse =
  | { type: "baked"; id: number; chunks: Array<[string, WirePlanes]> }
  | { type: "failed"; id: number; message: string };

/**
 * Chunks that differ between two map versions, or null when nothing does.
 *
 * Returns null rather than an empty patch so the caller can skip the post
 * entirely — this runs on every frame that carries a new map, and the
 * overwhelming majority of them changed nothing the worker cares about.
 */
export function diffMapChunks(
  prev: MapFile | null,
  next: MapFile,
): MapPatch | null {
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

/** Fold a patch into a map the worker owns outright, in place. */
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
