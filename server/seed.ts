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
 * It has one other caller, and that one *is* an overwrite: `World.reseed`,
 * behind `POST /api/seed`, which the deploy pipeline hits after every merge to
 * main so the live content tracks the repo. The write is the same straight
 * copy either way — what makes the boot path safe is its gate (an empty
 * store), and what makes the deploy path safe is that `reseed` immediately
 * replaces the running world with what was copied, keeping the players in it.
 *
 * A copy, not a reconciliation: a key the repo has since deleted stays in the
 * store, unreferenced by the content that replaced it.
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
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
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
