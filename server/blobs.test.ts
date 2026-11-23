import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBlobs } from "./blobs";
import { openDatabase, type Database } from "./db";

let directory: string;
let db: Database;
let blobs: SqliteBlobs;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-blobs-"));
  db = await openDatabase(join(directory, "world.db"));
  blobs = new SqliteBlobs(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

/** Bigger than one stored part, and not a whole number of them. */
function bigText(): string {
  return Array.from({ length: 300_000 }, (_, i) => `"${i},${i * 7}": [{"tileId":"grass"}]`).join(
    "\n",
  );
}

describe("a blob too big for one row", () => {
  it("reads back exactly as it was written", async () => {
    const text = bigText();

    await blobs.put("map.json", text, "application/json");

    expect(await blobs.getText("map.json")).toBe(text);
  });

  it("is replaced whole by a smaller one", async () => {
    await blobs.put("map.json", bigText(), "application/json");

    await blobs.put("map.json", "{}", "application/json");

    expect(await blobs.getText("map.json")).toBe("{}");
  });
});

describe("a file copied in by parts", () => {
  it("reads back exactly as the file is, over an older blob that had more parts", async () => {
    await blobs.put("map.json", `${bigText()}${bigText()}`, "application/json");
    const text = bigText();
    const path = join(directory, "map.json");
    await writeFile(path, text);

    await blobs.putFile("map.json", path, "application/json");

    expect(await blobs.getText("map.json")).toBe(text);
  });
});
