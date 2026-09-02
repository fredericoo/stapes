import { connect } from "@tursodatabase/database";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The database, which is Turso rather than SQLite proper.
 *
 * Turso is a from-scratch SQLite-compatible engine, so the storage model is the
 * one the Durable Object already used — `ctx.storage` is SQLite underneath, and
 * `GameServer` already wrote SQL for its chat table. Nothing about the data
 * changes shape by moving here.
 *
 * **Its API is asynchronous, and that is the one thing worth knowing.** There is
 * no synchronous escape hatch, which would ordinarily be a problem: `saveActors`
 * is synchronous and writes from inside a tick. It is not a problem, because
 * `WorldStore` buffers writes in memory and commits them in one transaction off
 * the tick — exactly what the Durable Object's unawaited `storage.put` was
 * doing, only now the batch is a transaction and therefore atomic.
 */
export type Database = Awaited<ReturnType<typeof connect>>;

/**
 * Schema, applied in order, each wrapped in its own transaction.
 *
 * Plain SQL and an integer version rather than a migration framework: there is
 * one writer, one database file per environment, and no team coordinating
 * branches of schema. A framework here would be more moving parts than the
 * thing it manages.
 *
 * Append only. Never edit a statement that has shipped — an existing database
 * has already run it and will not run it again.
 */
const MIGRATIONS: readonly string[] = [
  // v1 — the world's key/value checkpoint, and the chat log.
  //
  // `kv` is deliberately shaped like Durable Object storage rather than
  // normalised into per-actor and per-chunk tables. The 3,100 lines of
  // `GameServer` that read and write it are the most heavily tested code in the
  // repo, and reshaping their persistence in the same change that moves runtime
  // would mean the test suite proves nothing about either. Normalising is a
  // later refactor with the suite green on both sides of it.
  //
  // The value is a BLOB holding JSON. Not TEXT, because tileset PNGs go through
  // the same store and a TEXT column would mean base64 and a third of the space
  // again for no gain.
  `CREATE TABLE IF NOT EXISTS kv (
     key   TEXT PRIMARY KEY,
     value BLOB NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS chat (
     id    INTEGER PRIMARY KEY AUTOINCREMENT,
     at    INTEGER NOT NULL,
     actor TEXT NOT NULL,
     x     INTEGER NOT NULL,
     y     INTEGER NOT NULL,
     z     INTEGER NOT NULL,
     text  TEXT NOT NULL
   )`,
  // Authored content: the map, tile definitions, tilesets and their PNGs.
  // Separate from `kv` because it is a different kind of thing with a different
  // lifetime — `kv` is the world being played and is destroyed by a reset,
  // while this survives one and is what the reset reads *from*.
  `CREATE TABLE IF NOT EXISTS blob (
     key          TEXT PRIMARY KEY,
     content_type TEXT NOT NULL,
     bytes        BLOB NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  // The alarm, as a single row. A table rather than a column on a settings row
  // so that "no alarm set" is the absence of a row and cannot be confused with
  // an alarm set for the epoch.
  `CREATE TABLE IF NOT EXISTS alarm (
     id    INTEGER PRIMARY KEY CHECK (id = 0),
     at_ms INTEGER NOT NULL
   )`,
];

/**
 * Open the database, apply pragmas, and bring the schema up to date.
 *
 * `synchronous = NORMAL` under WAL can lose the last transactions to a host
 * power cut, but not to a process crash — which sits inside the checkpoint
 * window the design already accepts. `FULL` would buy a guarantee against a
 * failure mode a single unreplicated box does not survive anyway.
 */
export async function openDatabase(
  path: string,
  { exclusive = false } = {},
): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  const db = await connect(path);

  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA synchronous = NORMAL");
  await db.exec("PRAGMA foreign_keys = ON");
  // The single-writer guarantee, and the reason it lives here rather than in a
  // lockfile — see `server/lock.ts`. Off by default so tests can open a
  // database twice without ceremony; on for the one process that serves a world.
  if (exclusive) {
    await db.exec("PRAGMA locking_mode = EXCLUSIVE");
    // The pragma alone is a *declaration*, not an acquisition: the lock is
    // taken on the connection's first write and then held until it closes. On
    // a database whose migrations have all run there is no such write at boot,
    // so without this both processes would start, both load the world, and only
    // the first checkpoint — two seconds of divergent simulation later — would
    // fail. Take it now, while failing is still just a process that did not
    // start.
    await db.exec("BEGIN IMMEDIATE");
    await db.exec("COMMIT");
  }

  await migrate(db);
  return db;
}

async function migrate(db: Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
  );
  const versions = await db.prepare(
    "SELECT MAX(version) AS version FROM schema_version",
  );
  const row = (await versions.get()) as { version: number | null } | undefined;
  const applied = row?.version ?? 0;

  for (let index = applied; index < MIGRATIONS.length; index++) {
    await db.exec("BEGIN");
    try {
      await db.exec(MIGRATIONS[index]!);
      const record = await db.prepare(
        "INSERT INTO schema_version (version) VALUES (?)",
      );
      await record.run([index + 1]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(`Migration ${index + 1} failed: ${String(error)}`, {
        cause: error,
      });
    }
  }
}
