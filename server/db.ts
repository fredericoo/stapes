import { connect } from "@tursodatabase/database";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Database = Awaited<ReturnType<typeof connect>>;

const MIGRATIONS: readonly string[] = [
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
  `CREATE TABLE IF NOT EXISTS blob (
     key          TEXT PRIMARY KEY,
     content_type TEXT NOT NULL,
     bytes        BLOB NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS alarm (
     id    INTEGER PRIMARY KEY CHECK (id = 0),
     at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS user (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     email           TEXT NOT NULL UNIQUE,
     emailVerified   INTEGER NOT NULL DEFAULT 0,
     image           TEXT,
     createdAt       TEXT NOT NULL,
     updatedAt       TEXT NOT NULL,
     username        TEXT UNIQUE,
     displayUsername TEXT,
     -- USER or ADMIN, and only ever written by hand. The field is declared
     -- input-false in server/auth.ts, so nothing a client sends reaches it.
     role            TEXT NOT NULL DEFAULT 'USER'
   )`,
  `CREATE TABLE IF NOT EXISTS session (
     id        TEXT PRIMARY KEY,
     expiresAt TEXT NOT NULL,
     token     TEXT NOT NULL UNIQUE,
     createdAt TEXT NOT NULL,
     updatedAt TEXT NOT NULL,
     ipAddress TEXT,
     userAgent TEXT,
     userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS account (
     id                    TEXT PRIMARY KEY,
     accountId             TEXT NOT NULL,
     providerId            TEXT NOT NULL,
     userId                TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     accessToken           TEXT,
     refreshToken          TEXT,
     idToken               TEXT,
     accessTokenExpiresAt  TEXT,
     refreshTokenExpiresAt TEXT,
     scope                 TEXT,
     password              TEXT,
     createdAt             TEXT NOT NULL,
     updatedAt             TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS verification (
     id         TEXT PRIMARY KEY,
     identifier TEXT NOT NULL,
     value      TEXT NOT NULL,
     expiresAt  TEXT NOT NULL,
     createdAt  TEXT NOT NULL,
     updatedAt  TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS character (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS character_user ON character(user_id)`,
  `CREATE TABLE IF NOT EXISTS auth_secret (
     id     INTEGER PRIMARY KEY CHECK (id = 0),
     secret TEXT NOT NULL
   )`,
  `DELETE FROM kv WHERE key LIKE 'pos:%' OR key LIKE 'equip:%'
                     OR key LIKE 'tags:%' OR key LIKE 'mast:%'
                     OR key LIKE 'spawn:%' OR key LIKE 'status:%'
                     OR key LIKE 'hp:%' OR key LIKE 'pvp:%'`,
  `CREATE TABLE IF NOT EXISTS maintenance (
     id       INTEGER PRIMARY KEY CHECK (id = 0),
     message  TEXT,
     since_ms INTEGER NOT NULL
   )`,
];

export async function openDatabase(path: string, { exclusive = false } = {}): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  const db = await connect(path);

  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA synchronous = NORMAL");
  await db.exec("PRAGMA foreign_keys = ON");
  if (exclusive) {
    await db.exec("PRAGMA locking_mode = EXCLUSIVE");
    /**
     * The exclusive lock is taken on the first write, not by the pragma. This
     * empty write takes it now, so a second process fails at open instead of at
     * its first checkpoint.
     */
    await db.exec("BEGIN IMMEDIATE");
    await db.exec("COMMIT");
  }

  await migrate(db);
  return db;
}

async function migrate(db: Database): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const versions = await db.prepare("SELECT MAX(version) AS version FROM schema_version");
  const row = (await versions.get()) as { version: number | null } | undefined;
  const applied = row?.version ?? 0;

  for (let index = applied; index < MIGRATIONS.length; index++) {
    await db.exec("BEGIN");
    try {
      await db.exec(MIGRATIONS[index]!);
      const record = await db.prepare("INSERT INTO schema_version (version) VALUES (?)");
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
