import type { MapFile, TileDef, TilesetDef } from "./types";
import { normalizeTiles } from "./types";
import { emptyMap, parseMap, serializeMap } from "./mapData";
import { DEV_DATA_PREFIX } from "./devData";

/**
 * Authored content: the map, tile definitions, tilesets and their PNGs.
 *
 * Keys mirror the paths under the repo's `data/` directory, so a bucket listing
 * reads like the checked-in tree and `pnpm seed` is a straight upload.
 */
const MAP_KEY = "map.json";
const TILES_KEY = "tiles.json";
const TILESETS_KEY = "tilesets.json";
const TILESET_PREFIX = "tilesets/";

const JSON_TYPE = "application/json";
const PNG_TYPE = "image/png";

/** Tileset uploads name their own key, so the name is the whole attack surface. */
const SAFE_TILESET_NAME = /^[a-zA-Z0-9._-]+\.png$/;

/**
 * Bytes by key. Deliberately dumb — every decision about *what* the bytes mean
 * lives in {@link DataStore}, so the two backends stay small enough to see
 * through and cannot drift in how they parse a map.
 */
export interface Blobs {
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<void>;
}

/**
 * Production: an R2 bucket.
 *
 * R2 rather than KV because the editor saves and immediately reloads, and KV is
 * eventually consistent for up to a minute — an author would see their own
 * write as stale. R2 is read-after-write consistent per key, and a `put` is
 * atomic on its own.
 */
export class R2Blobs implements Blobs {
  constructor(private readonly bucket: R2Bucket) {}

  async getText(key: string) {
    const object = await this.bucket.get(key);
    return object ? object.text() : null;
  }

  async getBytes(key: string) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    // Uint8Array<ArrayBuffer>, not the default Uint8Array<ArrayBufferLike>:
    // only the concrete form is a valid Response body, and PNGs go into one.
    return new Uint8Array(await object.arrayBuffer());
  }

  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ) {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }
}

/**
 * Development: the repo's `data/` directory, over the Vite dev middleware.
 *
 * The Worker has no filesystem, so this talks to Node through the dev server
 * that is already in front of it. The point is that `data/` stays the single
 * source of truth while iterating: a tileset PNG edited in an external tool
 * shows up on the next request, and the editor's Save lands in `data/map.json`
 * as a reviewable diff rather than in an opaque local R2 blob.
 */
export class DevDiskBlobs implements Blobs {
  constructor(private readonly origin: string) {}

  private url(key: string) {
    return `${this.origin}${DEV_DATA_PREFIX}/${key}`;
  }

  private async read(key: string): Promise<Response | null> {
    const res = await fetch(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Dev data read failed for ${key}: ${res.status}`);
    }
    return res;
  }

  async getText(key: string) {
    const res = await this.read(key);
    return res ? res.text() : null;
  }

  async getBytes(key: string) {
    const res = await this.read(key);
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ) {
    const res = await fetch(this.url(key), {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!res.ok) {
      throw new Error(`Dev data write failed for ${key}: ${res.status}`);
    }
  }
}

export class DataStore {
  constructor(private readonly blobs: Blobs) {}

  async readTiles(): Promise<TileDef[]> {
    const raw = await this.blobs.getText(TILES_KEY);
    if (raw === null) return [];
    return normalizeTiles(JSON.parse(raw) as unknown[]);
  }

  async writeTiles(tiles: TileDef[]) {
    await this.blobs.put(
      TILES_KEY,
      `${JSON.stringify(tiles, null, 2)}\n`,
      JSON_TYPE,
    );
  }

  async readTilesets(): Promise<TilesetDef[]> {
    const raw = await this.blobs.getText(TILESETS_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as TilesetDef[];
  }

  async writeTilesets(tilesets: TilesetDef[]) {
    await this.blobs.put(
      TILESETS_KEY,
      `${JSON.stringify(tilesets, null, 2)}\n`,
      JSON_TYPE,
    );
  }

  async readMap(): Promise<MapFile> {
    const raw = await this.blobs.getText(MAP_KEY);
    if (raw === null) return emptyMap();
    return parseMap(raw);
  }

  async writeMap(map: MapFile) {
    await this.blobs.put(MAP_KEY, serializeMap(map), JSON_TYPE);
  }

  async readTilesetPng(fileName: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!SAFE_TILESET_NAME.test(fileName)) return null;
    return this.blobs.getBytes(TILESET_PREFIX + fileName);
  }

  async writeTilesetPng(fileName: string, bytes: Uint8Array<ArrayBuffer>) {
    if (!SAFE_TILESET_NAME.test(fileName)) {
      throw new Error("Invalid tileset filename");
    }
    await this.blobs.put(TILESET_PREFIX + fileName, bytes, PNG_TYPE);
  }
}

/**
 * Pick a backend.
 *
 * Dev reads and writes `data/` on disk so art iteration stays a save away, and
 * so editor saves show up in `git diff`. Production always takes R2. Set
 * `VITE_USE_R2=1` (`pnpm dev:r2`) to exercise the R2 path locally.
 *
 * Two ways to reach the disk, because the two dev runtimes differ in what sits
 * in front of the Worker:
 *
 * - `DATA_ORIGIN` names a file server running beside it. `pnpm dev:worker` sets
 *   it, since workerd has no Vite in front to ask.
 * - Otherwise, under Vite, the middleware is on the Worker's own origin — which
 *   is why this needs the origin to find it. The Durable Object has no request
 *   of its own, so it is told that origin by whoever calls in.
 */
export function dataStoreFor(env: Env, selfOrigin?: string): DataStore {
  if (env.DATA_ORIGIN) {
    return new DataStore(new DevDiskBlobs(env.DATA_ORIGIN));
  }
  const useVite =
    import.meta.env.DEV && import.meta.env.VITE_USE_R2 !== "1" && selfOrigin;
  return new DataStore(
    useVite ? new DevDiskBlobs(selfOrigin) : new R2Blobs(env.DATA),
  );
}

export function createDataStore(env: Env, request: Request): DataStore {
  return dataStoreFor(env, new URL(request.url).origin);
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Signature (8) + length (4) + "IHDR" (4) + width (4) + height (4). */
const IHDR_END = 24;

/**
 * Read PNG width/height out of the IHDR chunk without a decoder.
 *
 * Both fields are big-endian u32 at fixed offsets, so this stays a handful of
 * reads rather than a dependency.
 */
export function readPngSize(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (bytes.length < IHDR_END) throw new Error("Not a PNG");
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("Not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
