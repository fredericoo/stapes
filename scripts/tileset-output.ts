import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";
import type { TileDef, TilesetDef } from "../app/lib/types";

const DATA = path.resolve(import.meta.dirname, "..", "data");

export type Rgba = [number, number, number, number];

export function paletteRgba(index: number): Rgba {
  const hex = STAPES_PALETTE[index];
  if (!hex) throw new Error(`no palette entry ${index}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

export function paintRgba(sheet: PNG, x: number, y: number, colour: Rgba) {
  const i = (sheet.width * y + x) << 2;
  for (let c = 0; c < 4; c++) sheet.data[i + c] = colour[c]!;
}

export function paint(sheet: PNG, x: number, y: number, index: number) {
  paintRgba(sheet, x, y, paletteRgba(index));
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const GENERATED_KEYS = ["type", "anchor", "sprite", "slices"] as const;

/** Reports whether the tile's generated fields moved; anything authored on it is left alone. */
function updateTile(existing: TileDef, tile: TileDef): boolean {
  let changed = false;
  for (const key of GENERATED_KEYS) {
    if (JSON.stringify(existing[key]) === JSON.stringify(tile[key])) continue;
    Object.assign(existing, { [key]: tile[key] });
    changed = true;
  }
  return changed;
}

/**
 * Re-serialising `tiles.json` rewrites numbers other tools wrote as `0.0` and
 * `1.0`, so new tiles are appended to the text, and the file is only written
 * whole when a tile already in it has to change.
 */
async function writeTiles(generated: TileDef[]) {
  const file = path.join(DATA, "tiles.json");
  const text = await fs.readFile(file, "utf8");
  const tiles = JSON.parse(text) as TileDef[];
  const missing: TileDef[] = [];
  let changed = false;
  for (const tile of generated) {
    const existing = tiles.find((t) => t.id === tile.id);
    if (existing) changed = updateTile(existing, tile) || changed;
    else missing.push(tile);
  }
  if (changed) {
    await writeJson(file, [...tiles, ...missing]);
    return;
  }
  if (missing.length === 0) return;
  const appended = missing.map((tile) => JSON.stringify(tile, null, 2).replace(/^/gm, "  "));
  await fs.writeFile(file, text.replace(/\n\]\s*$/, `,\n${appended.join(",\n")}\n]\n`));
}

async function writeTilesetEntry(id: string, name: string, sheet: PNG) {
  const file = path.join(DATA, "tilesets.json");
  const sets = await readJson<TilesetDef[]>(file);
  const entry: TilesetDef = {
    id,
    name,
    file: `${id}.png`,
    width: sheet.width,
    height: sheet.height,
  };
  const set = sets.find((s) => s.id === id);
  if (set) Object.assign(set, entry);
  else sets.push(entry);
  await writeJson(file, sets);
}

/**
 * Writes a generated sheet, its `tilesets.json` entry and its tiles together, so
 * a generator cannot leave one of the three behind the others.
 */
export async function writeTileset(id: string, name: string, sheet: PNG, tiles: TileDef[]) {
  await fs.writeFile(path.join(DATA, "tilesets", `${id}.png`), PNG.sync.write(sheet));
  await writeTiles(tiles);
  await writeTilesetEntry(id, name, sheet);
  console.log(`data/tilesets/${id}.png — ${sheet.width}x${sheet.height}, ${tiles.length} tiles`);
}
