import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blobs } from "../app/lib/storage.server";

/**
 * Authored content, as it is laid out in the repository.
 *
 * Keys mirror the paths under `data/`, so what a listing shows reads like the
 * checked-in tree — which was true of the bucket this replaces and is worth
 * keeping, because it is what makes a seed a straight copy rather than a
 * translation.
 */
const JSON_FILES = ["map.json", "tiles.json", "tilesets.json", "statuses.json"];
const TILESET_DIRECTORY = "tilesets";

/**
 * Fill an empty store from the repository's `data/` directory.
 *
 * **Called on boot when the store has nothing in it**, which is what makes a
 * fresh deployment come up playable with no seeding step in the pipeline at
 * all. It is also most of why previews stopped being work: a pull request's
 * container starts against an empty volume, builds its own world from the image
 * it was built with, and needs nothing provisioned for it.
 *
 * Deliberately *not* a sync. It runs when there is nothing to overwrite, so it
 * can never put a branch's authored content over a world somebody is playing —
 * the failure the separate preview bucket existed to prevent. Replacing content
 * in a live environment is the editor's job, or `POST /api/reset`.
 */
export async function seedFromDirectory(
  blobs: Blobs,
  directory: string,
): Promise<void> {
  for (const name of JSON_FILES) {
    const text = await readIfPresent(join(directory, name));
    // An absent file is an empty environment, not a failure: `DataStore` reads
    // a missing map as an empty one and a missing catalogue as no entries.
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
