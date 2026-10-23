import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore, type Blobs } from "../app/lib/dataStore";
import { seedFromDirectory } from "./seed";

const made: string[] = [];

afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true });
});

function memoryBlobs(): Blobs {
  const kept = new Map<string, string | Uint8Array<ArrayBuffer>>();
  return {
    getText: async (key) => {
      const body = kept.get(key);
      return typeof body === "string" ? body : null;
    },
    getBytes: async () => null,
    put: async (key, body) => {
      kept.set(key, body);
    },
  };
}

describe("seeding a store from a directory", () => {
  it("copies the trait catalogue with the rest of the authored content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stapes-seed-"));
    made.push(directory);
    const traits = [{ id: "yelps", name: "Yelps" }];
    await writeFile(join(directory, "traits.json"), JSON.stringify(traits));
    const blobs = memoryBlobs();

    await seedFromDirectory(blobs, directory);

    expect(await new DataStore(blobs).readTraits()).toEqual(traits);
  });
});
