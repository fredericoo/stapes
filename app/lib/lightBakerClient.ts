/**
 * Main-thread half of the light baking worker.
 *
 * Implements {@link ChunkBaker}, so the light cache neither knows nor cares
 * that a worker is involved — attach one and edits stop costing frames, attach
 * nothing and everything bakes inline exactly as it always did.
 */
import type { BakedChunk, ChunkBaker, WorldRect } from "./lightingChunks";
import {
  type BakerRequest,
  type BakerResponse,
  diffMapChunks,
} from "./lightBakerProtocol";
import type { MapFile, TileDef } from "./types";

/**
 * Whether this environment can run one at all.
 *
 * False under SSR and under the test runner, and both are load-bearing rather
 * than defensive: the renderer is built on the client only, but the light cache
 * is exercised directly by unit tests, and those must keep taking the
 * synchronous path or they would be asserting on results that had not arrived.
 */
export function canBakeOffThread(): boolean {
  return typeof Worker !== "undefined";
}

type Pending = {
  resolve: (chunks: Map<string, BakedChunk>) => void;
  reject: (err: Error) => void;
};

export class WorkerChunkBaker implements ChunkBaker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;
  /** Map version the worker's copy is known to match. */
  private mirrored: MapFile | null = null;

  constructor(tiles: TileDef[], omit: ReadonlySet<string>, map: MapFile) {
    this.worker = new Worker(
      new URL("./lightBaker.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (event: MessageEvent<BakerResponse>) =>
      this.onMessage(event.data);
    // A worker that died takes every request in flight with it. Failing them
    // leaves the cache with stale chunks it will ask about again, which is the
    // same state a refused bake leaves behind — so a broken worker degrades to
    // slightly-old light rather than to no light.
    this.worker.onerror = () => this.failAll("light worker errored");

    this.post({ type: "init", tiles, omit: [...omit], map });
    this.mirrored = map;
  }

  /**
   * Bring the worker's copy of the map up to date with `next`.
   *
   * Called with the same pair the light cache diffs, and for the same reason it
   * has to be called *before* any bake for this frame: messages are delivered
   * in order, so a patch posted first is applied first, and a request cannot be
   * served against a map older than the edit that prompted it.
   */
  syncMap(next: MapFile) {
    if (this.disposed) return;
    const patch = diffMapChunks(this.mirrored, next);
    this.mirrored = next;
    if (patch) this.post({ type: "patch", patch });
  }

  bake(rect: WorldRect, timeMs: number): Promise<Map<string, BakedChunk>> {
    if (this.disposed) return Promise.reject(new Error("baker disposed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: "bake", id, rect, timeMs });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll("light worker disposed");
    this.worker.terminate();
  }

  private post(message: BakerRequest) {
    this.worker.postMessage(message);
  }

  private onMessage(message: BakerResponse) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.type === "failed") {
      entry.reject(new Error(message.message));
      return;
    }
    const chunks = new Map<string, BakedChunk>();
    for (const [key, wire] of message.chunks) {
      chunks.set(key, {
        planes: new Map(wire.planes),
        animated: wire.animated,
      });
    }
    entry.resolve(chunks);
  }

  private failAll(reason: string) {
    for (const entry of this.pending.values()) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
