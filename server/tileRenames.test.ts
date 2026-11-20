import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TILE_ID_RENAMES, renameTileIdsInJson, renameTileIdsSql } from "../app/lib/tileRenames";
import { openDatabase, type Database } from "./db";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stapes-renames-"));
  db = await openDatabase(join(dir, "stapes.db"));
});

afterEach(async () => {
  await db.close?.();
  await rm(dir, { recursive: true, force: true });
});

const STORED: Record<string, unknown> = {
  "equip:alice": {
    weapon: { id: "1", tileId: "arcane-stone-of-flame" },
    bag: { tileId: "basic-bag", contents: [{ tileId: "arcane-stone-of-pyre", count: 2 }] },
  },
  "chunk:0:0": [
    [
      { tileId: "sand-dunes" },
      { tileId: "grass" },
      { tileId: "grass-2" },
      {
        tileId: "chest",
        rewardTileIds: ["arcane-stone-of-bolt"],
        rewardCounts: { "arcane-stone-of-bolt": 3 },
      },
    ],
  ],
  "depot:alice": { slots: [{ tileId: "arcane-stone" }, { tileId: "test-arcane-stone-of-x" }] },
};

describe("renamed tile ids", () => {
  it("are rewritten the same way by the database migration and by the local world", async () => {
    const put = await db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(STORED)) await put.run([key, JSON.stringify(value)]);

    for (const rename of TILE_ID_RENAMES) await db.exec(renameTileIdsSql(rename, "kv", "value"));

    const read = await db.prepare("SELECT value FROM kv WHERE key = ?");
    for (const [key, value] of Object.entries(STORED)) {
      const row = (await read.get([key])) as { value: string | Uint8Array };
      const text = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
      expect(text).toBe(renameTileIdsInJson(JSON.stringify(value)));
    }
  });

  it("leave ids that only contain an old prefix alone", () => {
    const text = renameTileIdsInJson(JSON.stringify(STORED));

    expect(text).not.toContain('"arcane-stone-of-');
    expect(text).toContain('"rune-flame"');
    expect(text).toContain('"rune-bolt":3');
    expect(text).toContain('"arcane-stone"');
    expect(text).toContain('"test-arcane-stone-of-x"');
    expect(text).toContain('{"tileId":"sand"}');
    expect(text).not.toContain('"sand-dunes"');
    expect(text).toContain('{"tileId":"tuft"}');
    expect(text).toContain('{"tileId":"grass-2"}');
  });
});
