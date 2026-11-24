import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blobs } from "../app/lib/dataStore";

/** The hash of the directory a store was last seeded from, kept beside what it seeded. */
const SEEDED_FROM_KEY = "seeded-from";

const JSON_FILES = ["world.json", "tiles.json", "tilesets.json", "statuses.json", "traits.json"];
const TILESET_DIRECTORY = "tilesets";

/**
 * `treeFile` is the file in `directory` stored as the world's `world.json`, the
 * tree its map is built from, so a staging world can be built from a smaller
 * island than production's.
 */
export async function seedFromDirectory(
  blobs: Blobs,
  directory: string,
  treeFile = "world.json",
): Promise<void> {
  for (const name of JSON_FILES) {
    const text = await readIfPresent(join(directory, name === "world.json" ? treeFile : name));
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

/**
 * Seeds the store when `directory` holds different content from what it was
 * last seeded with, which is what a new image brings. Returns whether it did.
 */
export async function seedIfChanged(
  blobs: Blobs,
  directory: string,
  treeFile = "world.json",
): Promise<boolean> {
  const hash = await contentHash(directory, treeFile);
  if ((await blobs.getText(SEEDED_FROM_KEY)) === hash) return false;
  await seedFromDirectory(blobs, directory, treeFile);
  await blobs.put(SEEDED_FROM_KEY, hash, "text/plain");
  return true;
}

async function contentHash(directory: string, treeFile: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of JSON_FILES) {
    const text = await readIfPresent(join(directory, name === "world.json" ? treeFile : name));
    hash
      .update(name)
      .update("\0")
      .update(text ?? "")
      .update("\0");
  }
  let entries: string[] = [];
  try {
    entries = (await readdir(join(directory, TILESET_DIRECTORY))).sort();
  } catch {
    entries = [];
  }
  for (const file of entries) {
    if (!file.endsWith(".png")) continue;
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(directory, TILESET_DIRECTORY, file)));
  }
  return hash.digest("hex");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
