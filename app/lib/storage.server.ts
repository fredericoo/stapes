import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../context";
import type { MapFile, TileDef, TilesetDef } from "./types";
import { normalizeTiles } from "./types";
import { emptyMap, parseMap, serializeMap } from "./mapData";

/**
 * Authored content, in R2.
 *
 * Keys mirror the paths the repo's `data/` directory uses, so `pnpm seed` is a
 * straight upload and a bucket listing reads like the checked-in tree.
 *
 * R2 rather than KV because the editor saves and immediately reloads: KV is
 * eventually consistent for up to a minute, which would show an author their
 * own write as stale. R2 is read-after-write consistent per key, and a `put`
 * is atomic on its own — the tmp-file-and-rename dance the disk store needed
 * has no equivalent here because there is nothing to be half-written.
 */
const MAP_KEY = "map.json";
const TILES_KEY = "tiles.json";
const TILESETS_KEY = "tilesets.json";
const TILESET_PREFIX = "tilesets/";

/** Tileset uploads name their own key, so the name is the whole attack surface. */
const SAFE_TILESET_NAME = /^[a-zA-Z0-9._-]+\.png$/;

export class DataStore {
  constructor(private readonly bucket: R2Bucket) {}

  async readTiles(): Promise<TileDef[]> {
    const raw = await this.bucket.get(TILES_KEY);
    if (!raw) return [];
    return normalizeTiles(JSON.parse(await raw.text()) as unknown[]);
  }

  async writeTiles(tiles: TileDef[]) {
    await this.bucket.put(TILES_KEY, `${JSON.stringify(tiles, null, 2)}\n`);
  }

  async readTilesets(): Promise<TilesetDef[]> {
    const raw = await this.bucket.get(TILESETS_KEY);
    if (!raw) return [];
    return JSON.parse(await raw.text()) as TilesetDef[];
  }

  async writeTilesets(tilesets: TilesetDef[]) {
    await this.bucket.put(
      TILESETS_KEY,
      `${JSON.stringify(tilesets, null, 2)}\n`,
    );
  }

  async readMap(): Promise<MapFile> {
    const raw = await this.bucket.get(MAP_KEY);
    if (!raw) return emptyMap();
    return parseMap(await raw.text());
  }

  async writeMap(map: MapFile) {
    await this.bucket.put(MAP_KEY, serializeMap(map));
  }

  // Uint8Array<ArrayBuffer>, not the default Uint8Array<ArrayBufferLike>: only
  // the concrete form is a valid Response body, and this goes straight into one.
  async readTilesetPng(fileName: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!SAFE_TILESET_NAME.test(fileName)) return null;
    const object = await this.bucket.get(TILESET_PREFIX + fileName);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async writeTilesetPng(fileName: string, bytes: Uint8Array) {
    if (!SAFE_TILESET_NAME.test(fileName)) {
      throw new Error("Invalid tileset filename");
    }
    await this.bucket.put(TILESET_PREFIX + fileName, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
  }
}

/**
 * The store for this request, from the Worker bindings in context.
 *
 * `Readonly` because that is what loaders and actions are handed — they may
 * read the request's contexts but not set new ones.
 */
export function dataStore(context: Readonly<RouterContextProvider>): DataStore {
  return new DataStore(context.get(cloudflareContext).env.DATA);
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
