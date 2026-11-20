import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blobs } from "../app/lib/dataStore";

const JSON_FILES = [
  "map.json",
  "tiles.json",
  "tilesets.json",
  "statuses.json",
  "traits.json",
  "weather.json",
];
const TILESET_DIRECTORY = "tilesets";

/**
 * `mapFile` is the file in `directory` stored as the world's `map.json`, so a
 * staging world can be seeded from a smaller map than production's.
 */
export async function seedFromDirectory(
  blobs: Blobs,
  directory: string,
  mapFile = "map.json",
): Promise<void> {
  for (const name of JSON_FILES) {
    const text = await readIfPresent(join(directory, name === "map.json" ? mapFile : name));
    if (text !== null) await blobs.put(name, text, "application/json");
  }

  let entries: string[];
  try {
    entries = await readdir(join(directory, TILESET_DIRECTORY));
  } catch {
    return;
  }

  for (const file of entries) {
    if (!file.endsWith(".png")) continue;
    const bytes = await readFile(join(directory, TILESET_DIRECTORY, file));
    await blobs.put(
      `${TILESET_DIRECTORY}/${file}`,
      new Uint8Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ) as Uint8Array<ArrayBuffer>,
      "image/png",
    );
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
