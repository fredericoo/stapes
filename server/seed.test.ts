import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore, type Blobs } from "../app/lib/dataStore";
import { seedFromDirectory, seedIfChanged } from "./seed";

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

  it("stores the named tree file as the world's tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stapes-seed-"));
    made.push(directory);
    await writeFile(join(directory, "world.json"), "{}");
    await writeFile(join(directory, "world-staging.json"), '{"staging":true}');
    const blobs = memoryBlobs();

    await seedFromDirectory(blobs, directory, "world-staging.json");

    expect(await new DataStore(blobs).readTreeText()).toBe('{"staging":true}');
  });

  it("seeds again only once the directory's content changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stapes-seed-"));
    made.push(directory);
    await writeFile(join(directory, "traits.json"), "[]");
    const blobs = memoryBlobs();

    expect(await seedIfChanged(blobs, directory)).toBe(true);
    await blobs.put("traits.json", '[{"id":"edited"}]', "application/json");
    expect(await seedIfChanged(blobs, directory)).toBe(false);
    expect(await blobs.getText("traits.json")).toBe('[{"id":"edited"}]');

    await writeFile(join(directory, "traits.json"), '[{"id":"shipped"}]');
    expect(await seedIfChanged(blobs, directory)).toBe(true);
    expect(await blobs.getText("traits.json")).toBe('[{"id":"shipped"}]');
  });
});
