import { bakeRegion } from "./lightingChunks";
import {
  applyMapPatch,
  type BakerRequest,
  type BakerResponse,
  type WireChunk,
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
    /**
     * Kept rather than cloned: `msg.map` arrived by structured clone and
     * belongs to nobody else, which is what lets `applyMapPatch` write into
     * it directly.
     */
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
    reply({ type: "failed", id: msg.id, message: "bake before init" }, []);
    return;
  }

  try {
    const baked = bakeRegion(map, tilesById, omit, msg.rect, msg.timeMs);
    const chunks: Array<[string, WireChunk]> = [];
    /**
     * Every plane here is freshly allocated by the bake and read by nobody
     * on this side, so the buffers are transferred rather than copied — this
     * side is left with detached views it never touches.
     */
    const transfer: Transferable[] = [];
    for (const [key, chunk] of baked) {
      const wire: WirePlanes = [];
      for (const [z, rgba] of chunk.planes) {
        wire.push([z, rgba]);
        transfer.push(rgba.buffer);
      }
      chunks.push([key, { planes: wire, animated: chunk.animated }]);
    }
    reply({ type: "baked", id: msg.id, chunks }, transfer);
  } catch (err) {
    reply({ type: "failed", id: msg.id, message: String(err) }, []);
  }
};
