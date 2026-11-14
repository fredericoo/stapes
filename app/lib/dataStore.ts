import { parseWeatherAreas, type WeatherArea } from "./weatherAreas";
import type { FlatMapFile, MapFile, TileDef, TilesetDef } from "./types";
import { MAP_FILE_VERSION, normalizeTiles } from "./types";
import { emptyMap, parseFlatMap, parseMap, serializeMap } from "./mapData";

const MAP_KEY = "map.json";
const TILES_KEY = "tiles.json";
const TILESETS_KEY = "tilesets.json";
const STATUSES_KEY = "statuses.json";
const TRAITS_KEY = "traits.json";
const WEATHER_KEY = "weather.json";
const TILESET_PREFIX = "tilesets/";

const JSON_TYPE = "application/json";
const PNG_TYPE = "image/png";

const SAFE_TILESET_NAME = /^[a-zA-Z0-9._-]+\.png$/;

const TILESET_VERSION_HEX_LENGTH = 16;

export const TILESET_VERSION_PARAM = "v";

export interface Blobs {
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(key: string, body: string | Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
}

export class DataStore {
  constructor(private readonly blobs: Blobs) {}

  async readTiles(): Promise<TileDef[]> {
    const raw = await this.blobs.getText(TILES_KEY);
    if (raw === null) return [];
    return normalizeTiles(JSON.parse(raw) as unknown[]);
  }

  async writeTiles(tiles: TileDef[]) {
    await this.blobs.put(TILES_KEY, `${JSON.stringify(tiles, null, 2)}\n`, JSON_TYPE);
  }

  async readStatuses(): Promise<unknown[]> {
    const raw = await this.blobs.getText(STATUSES_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  async writeStatuses(statuses: unknown[]) {
    await this.blobs.put(STATUSES_KEY, `${JSON.stringify(statuses, null, 2)}\n`, JSON_TYPE);
  }

  async readTraits(): Promise<unknown[]> {
    const raw = await this.blobs.getText(TRAITS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  async writeTraits(traits: unknown[]) {
    await this.blobs.put(TRAITS_KEY, `${JSON.stringify(traits, null, 2)}\n`, JSON_TYPE);
  }

  async readWeatherAreas(): Promise<WeatherArea[]> {
    const raw = await this.blobs.getText(WEATHER_KEY);
    if (raw === null) return [];
    return parseWeatherAreas(JSON.parse(raw) as unknown);
  }

  async writeWeatherAreas(areas: WeatherArea[]) {
    await this.blobs.put(WEATHER_KEY, `${JSON.stringify(areas, null, 2)}\n`, JSON_TYPE);
  }

  async readTilesets(): Promise<TilesetDef[]> {
    const raw = await this.blobs.getText(TILESETS_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as TilesetDef[];
  }

  /** Each def carries a hash of its sheet's bytes, so a sheet's URL changes exactly when the sheet does. */
  async readVersionedTilesets(): Promise<TilesetDef[]> {
    const tilesets = await this.readTilesets();
    return Promise.all(
      tilesets.map(async (tileset) => {
        const version = await this.readTilesetVersion(tileset.file);
        return version === null ? tileset : { ...tileset, version };
      }),
    );
  }

  async readTilesetVersion(fileName: string): Promise<string | null> {
    const bytes = await this.readTilesetPng(fileName);
    return bytes === null ? null : contentVersion(bytes);
  }

  /** A version is derived from the stored bytes on every read; one written into the catalogue would go stale. */
  async writeTilesets(tilesets: TilesetDef[]) {
    const unversioned = tilesets.map(({ version: _version, ...tileset }) => tileset);
    await this.blobs.put(TILESETS_KEY, `${JSON.stringify(unversioned, null, 2)}\n`, JSON_TYPE);
  }

  async readMap(): Promise<MapFile> {
    const raw = await this.blobs.getText(MAP_KEY);
    if (raw === null) return emptyMap();
    return parseMap(raw);
  }

  async readFlatMap(): Promise<FlatMapFile> {
    const raw = await this.blobs.getText(MAP_KEY);
    if (raw === null) return { version: MAP_FILE_VERSION, levels: {} };
    return parseFlatMap(raw);
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

async function contentVersion(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, TILESET_VERSION_HEX_LENGTH);
}
