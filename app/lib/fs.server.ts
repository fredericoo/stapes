import { promises as fs } from "node:fs";
import path from "node:path";
import type { MapFile, TileDef, TilesetDef } from "./types";
import { normalizeTiles } from "./types";
import { emptyMap, parseMap, serializeMap } from "./mapData";

const DATA_DIR = path.resolve(process.cwd(), "data");

function tilesPath() {
  return path.join(DATA_DIR, "tiles.json");
}

function tilesetsPath() {
  return path.join(DATA_DIR, "tilesets.json");
}

function mapPath() {
  return path.join(DATA_DIR, "map.json");
}

export function tilesetsDir() {
  return path.join(DATA_DIR, "tilesets");
}

async function ensureDataDir() {
  await fs.mkdir(tilesetsDir(), { recursive: true });
}

async function atomicWrite(filePath: string, contents: string | Buffer) {
  await ensureDataDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, filePath);
}

export async function readTiles(): Promise<TileDef[]> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(tilesPath(), "utf8");
    return normalizeTiles(JSON.parse(raw) as unknown[]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function writeTiles(tiles: TileDef[]) {
  await atomicWrite(tilesPath(), `${JSON.stringify(tiles, null, 2)}\n`);
}

export async function readTilesets(): Promise<TilesetDef[]> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(tilesetsPath(), "utf8");
    return JSON.parse(raw) as TilesetDef[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function writeTilesets(tilesets: TilesetDef[]) {
  await atomicWrite(tilesetsPath(), `${JSON.stringify(tilesets, null, 2)}\n`);
}

export async function readMap(): Promise<MapFile> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(mapPath(), "utf8");
    return parseMap(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyMap();
    throw err;
  }
}

export async function writeMap(map: MapFile) {
  await atomicWrite(mapPath(), serializeMap(map));
}

export async function writeTilesetPng(fileName: string, buffer: Buffer) {
  if (!/^[a-zA-Z0-9._-]+\.png$/.test(fileName)) {
    throw new Error("Invalid tileset filename");
  }
  await ensureDataDir();
  const dest = path.join(tilesetsDir(), fileName);
  await atomicWrite(dest, buffer);
}

export async function readTilesetPng(fileName: string): Promise<Buffer | null> {
  if (!/^[a-zA-Z0-9._-]+\.png$/.test(fileName)) {
    return null;
  }
  try {
    return await fs.readFile(path.join(tilesetsDir(), fileName));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read PNG IHDR for width/height without a heavy decoder. */
export function readPngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) throw new Error("Not a PNG");
  const sig = buffer.subarray(0, 8);
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!sig.equals(expected)) throw new Error("Not a PNG");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}
