/**
 * Light baking, off the main thread.
 *
 * Holds its own copy of the map and the tile catalogue so a request can be a
 * rect and nothing more — see {@link ./lightBakerProtocol} for why that matters.
 * The bake itself is the same {@link bakeRegion} the synchronous path calls, so
 * there is one implementation of what light looks like and this file only
 * decides where it runs.
 */
import { bakeRegion } from "./lightingChunks";
import {
  applyMapPatch,
  type BakerRequest,
  type BakerResponse,
  type WirePlanes,
} from "./lightBakerProtocol";
import type { MapFile, TileDef } from "./types";

let map: MapFile | null = null;
let tilesById: Record<string, TileDef> = {};
let omit: ReadonlySet<string> | undefined;

function reply(message: BakerResponse, transfer: Transferable[]) {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<BakerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    // Kept rather than cloned: this object arrived by structured clone and
    // belongs to nobody else, which is what lets `applyMapPatch` write into it.
    map = msg.map;
    tilesById = Object.fromEntries(msg.tiles.map((t) => [t.id, t]));
    omit = msg.omit.length ? new Set(msg.omit) : undefined;
    return;
  }

  if (msg.type === "patch") {
    if (map) applyMapPatch(map, msg.patch);
    return;
  }

  if (msg.type !== "bake") return;

  if (!map) {
    reply(
      { type: "failed", id: msg.id, message: "bake before init" },
      [],
    );
    return;
  }

  try {
    const baked = bakeRegion(map, tilesById, omit, msg.rect);
    const chunks: Array<[string, WirePlanes]> = [];
    // Every plane is freshly allocated by the bake and read by nobody here, so
    // they go across by transfer rather than by copy — the buffers are simply
    // handed over and this side is left with detached views it never touches.
    const transfer: Transferable[] = [];
    for (const [key, planes] of baked) {
      const wire: WirePlanes = [];
      for (const [z, rgba] of planes) {
        wire.push([z, rgba]);
        transfer.push(rgba.buffer);
      }
      chunks.push([key, wire]);
    }
    reply({ type: "baked", id: msg.id, chunks }, transfer);
  } catch (err) {
    reply(
      { type: "failed", id: msg.id, message: String(err) },
      [],
    );
  }
};
