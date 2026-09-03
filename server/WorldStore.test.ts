import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "./db";
import { WorldStore } from "./WorldStore";

/**
 * The storage the world checkpoints into.
 *
 * Tested against a real database file rather than a stub, for the reason the
 * suite it replaces ran inside workerd: the two bugs that ever shipped in
 * `GameServer` both lived in the load and restore paths, and a fake store
 * cannot have the behaviour those paths trip over.
 */

let dir: string;
let db: Database;
let store: WorldStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stapes-store-"));
  db = await openDatabase(join(dir, "stapes.db"));
  store = new WorldStore(db);
});

afterEach(async () => {
  await db.close?.();
  await rm(dir, { recursive: true, force: true });
});

describe("buffered writes", () => {
  it("reads back a value before it has been committed", async () => {
    // The tick writes and the tick reads, and the commit is off the tick — so a
    // buffered value that could not be read back would be a world that forgets
    // what it just did for up to two seconds.
    await store.put("a", { n: 1 });
    expect(await store.get<unknown>("a")).toEqual({ n: 1 });
  });

  it("survives a flush", async () => {
    await store.put("a", { n: 1 });
    await store.flush();
    expect(await store.get<unknown>("a")).toEqual({ n: 1 });
  });

  it("is durable across reopening the database", async () => {
    await store.put("chunk:0:0", [{ tileId: "grass" }]);
    await store.flush();
    await db.close?.();

    db = await openDatabase(join(dir, "stapes.db"));
    store = new WorldStore(db);
    expect(await store.get<unknown>("chunk:0:0")).toEqual([
      { tileId: "grass" },
    ]);
  });

  it("hides a deleted key even before the delete is committed", async () => {
    await store.put("a", { n: 1 });
    await store.flush();
    await store.delete("a");

    expect(await store.get("a")).toBeUndefined();
    await store.flush();
    expect(await store.get("a")).toBeUndefined();
  });

  it("takes a later write over an earlier delete", async () => {
    await store.put("a", { n: 1 });
    await store.flush();
    await store.delete("a");
    await store.put("a", { n: 2 });
    await store.flush();

    expect(await store.get<unknown>("a")).toEqual({ n: 2 });
  });
});

describe("listing", () => {
  it("merges committed rows with buffered ones", async () => {
    // `pruneOldest` lists a prefix and deletes the oldest it finds. A listing
    // that missed the actors written since the last flush would prune against a
    // stale view and throw away somebody who had just been saved.
    await store.put("actor:a", { savedAt: 1 });
    await store.flush();
    await store.put("actor:b", { savedAt: 2 });

    const listed = await store.list<{ savedAt: number }>({ prefix: "actor:" });
    expect([...listed.keys()]).toEqual(["actor:a", "actor:b"]);
  });

  it("omits buffered deletions", async () => {
    await store.put({ "actor:a": { savedAt: 1 }, "actor:b": { savedAt: 2 } });
    await store.flush();
    await store.delete("actor:a");

    const listed = await store.list({ prefix: "actor:" });
    expect([...listed.keys()]).toEqual(["actor:b"]);
  });

  it("stops at the prefix rather than running past it", async () => {
    // The listing is a range scan so the primary key index does the work. An
    // off-by-one in the upper bound would quietly pull in neighbouring keys —
    // `chunk:` reading `chunkX:` — and reassemble a board from them.
    await store.put({ "chunk:1": [1], "chunkX:1": [2], chunj: [3] });
    await store.flush();

    const listed = await store.list({ prefix: "chunk:" });
    expect([...listed.keys()]).toEqual(["chunk:1"]);
  });
});

describe("atomicity", () => {
  it("commits the board and the actors in one transaction", async () => {
    // This is the bug `pendingDeathWrites` exists to work around in the Durable
    // Object: the board write and the actor write could land separately, which
    // is how a sword carried into a losing fight ended up in neither its
    // owner's kit nor the cell it was taken from. One transaction or neither.
    await store.put({
      "chunk:0:0": [{ tileId: "sword" }],
      "equipment:alice": { hands: [] },
    });

    const before = await rowCount(db);
    expect(before).toBe(0);

    await store.flush();
    expect(await rowCount(db)).toBe(2);
  });

  it("writes made during a flush belong to the next one", async () => {
    // The batch is taken before the first await. A write landing mid-commit
    // must not be half-applied, and must not be lost either.
    await store.put("a", { n: 1 });
    const flushing = store.flush();
    await store.put("b", { n: 2 });
    await flushing;

    expect(await rowCount(db)).toBe(1);
    await store.flush();
    expect(await rowCount(db)).toBe(2);
  });
});

describe("alarms", () => {
  it("round-trips through storage", async () => {
    await store.setAlarm(1234);
    await store.flush();
    expect(await store.loadAlarm()).toBe(1234);
  });

  it("clears", async () => {
    await store.setAlarm(1234);
    await store.flush();
    await store.deleteAlarm();
    await store.flush();
    expect(await store.loadAlarm()).toBeNull();
  });
});

describe("deleteAll", () => {
  it("forgets the world, buffered writes included", async () => {
    await store.put("a", { n: 1 });
    await store.flush();
    await store.put("b", { n: 2 });

    await store.deleteAll();

    expect(await rowCount(db)).toBe(0);
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeUndefined();
  });

  it("runs a queued statement rather than discarding it", async () => {
    // `resetWorld` queues `DROP TABLE IF EXISTS chat` and then calls this. A
    // buffered write describes the world being thrown away and should go with
    // it; a hand-written statement is aimed at the database and must not.
    store.sql.exec("CREATE TABLE IF NOT EXISTS scratch (a)");
    await store.deleteAll();

    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scratch'",
    );
    expect(await tables.all()).toHaveLength(1);
  });

  it("leaves tables made through sql alone", async () => {
    // The key-value side only, which is what it replaced. `GameServer` drops
    // its chat table by name for exactly this reason.
    store.sql.exec(
      "INSERT INTO chat (at, actor, x, y, z, text) VALUES (1,'a',0,0,0,'hi')",
    );
    await store.flush();

    await store.deleteAll();

    const rows = await db.prepare("SELECT COUNT(*) AS n FROM chat");
    expect(((await rows.get()) as { n: number }).n).toBe(1);
  });
});

async function rowCount(database: Database): Promise<number> {
  const statement = await database.prepare("SELECT COUNT(*) AS n FROM kv");
  const row = (await statement.get()) as { n: number } | undefined;
  return row?.n ?? 0;
}
