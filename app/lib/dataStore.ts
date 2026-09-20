import type { MapFile, TileDef, TilesetDef } from "./types";
import { normalizeTiles } from "./types";
import { emptyMap, parseMap, serializeMap } from "./mapData";

/**
 * Authored content: the map, tile definitions, tilesets and their PNGs.
 *
 * Keys mirror the paths under the repo's `data/` directory, so a bucket listing
 * reads like the checked-in tree and `pnpm seed` is a straight upload.
 */
const MAP_KEY = "map.json";
const TILES_KEY = "tiles.json";
const TILESETS_KEY = "tilesets.json";
/**
 * The status catalogue. A fourth blob rather than a kind of tile: a status is
 * never placed, never stacked and never walked into, so giving it a `TileDef`
 * would put entries in `tilesById` that can never appear on a board. See
 * `./status`.
 */
const STATUSES_KEY = "statuses.json";
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

  /**
   * The status catalogue, still raw.
   *
   * Handed over unparsed on purpose, exactly as tiles are handed over
   * un-resolved: `statusesById` is what decides which entries are statuses, it
   * memoises nothing and it runs on both sides of the wire. A store that parsed
   * here would be a second place that has an opinion about what a status is.
   *
   * An absent file is an empty catalogue rather than a failure — a fresh
   * environment loads blank until `pnpm seed` runs, the same as the map does.
   */
  async readStatuses(): Promise<unknown[]> {
    const raw = await this.blobs.getText(STATUSES_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  async writeStatuses(statuses: unknown[]) {
    await this.blobs.put(
      STATUSES_KEY,
      `${JSON.stringify(statuses, null, 2)}\n`,
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
