import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { Blobs } from "../app/lib/dataStore";
import type { Database } from "./db";

const BLOB_PART_BYTES = 1 << 20;

const PARTS_PER_FILE_BATCH = 8;

const PARTS_SUFFIX = "~parts-";

export class SqliteBlobs implements Blobs {
  constructor(private readonly db: Database) {}

  async getText(key: string): Promise<string | null> {
    const bytes = await this.getBytes(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const statement = await this.db.prepare("SELECT bytes, parts_key FROM blob WHERE key = ?");
    const row = (await statement.get([key])) as
      | { bytes: Uint8Array | string; parts_key: string | null }
      | undefined;
    if (!row) return null;
    const parts = await this.db.prepare("SELECT bytes FROM blob_part WHERE key = ? ORDER BY n");
    const rows = (await parts.all([row.parts_key ?? key])) as { bytes: Uint8Array }[];
    if (rows.length === 0) return toBytes(row.bytes);
    const whole = new Uint8Array(rows.reduce((sum, part) => sum + part.bytes.length, 0));
    let at = 0;
    for (const part of rows) {
      whole.set(part.bytes, at);
      at += part.bytes.length;
    }
    return whole;
  }

  /**
   * A body over `BLOB_PART_BYTES` is stored as parts in `blob_part`, with an
   * empty row in `blob`. Inserting a whole island's map as one value peaked at
   * about 600 MB above the map; in 1 MB parts, about 200 MB.
   */
  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const parted = bytes.length > BLOB_PART_BYTES;
    const previous = await this.partsKeyOf(key);
    const statements: { sql: string; args: unknown[] }[] = [
      { sql: "DELETE FROM blob_part WHERE key = ?", args: [key] },
      ...(previous && previous !== key
        ? [{ sql: "DELETE FROM blob_part WHERE key = ?", args: [previous] }]
        : []),
      {
        sql: `INSERT INTO blob (key, content_type, bytes, parts_key, updated_at) VALUES (?, ?, ?, NULL, ?)
              ON CONFLICT(key) DO UPDATE SET
                content_type = excluded.content_type,
                bytes        = excluded.bytes,
                parts_key    = NULL,
                updated_at   = excluded.updated_at`,
        args: [key, contentType, parted ? new Uint8Array(0) : bytes, Date.now()],
      },
    ];
    if (parted) {
      for (let at = 0, n = 0; at < bytes.length; at += BLOB_PART_BYTES, n++) {
        statements.push({
          sql: "INSERT INTO blob_part (key, n, bytes) VALUES (?, ?, ?)",
          args: [key, n, bytes.subarray(at, at + BLOB_PART_BYTES)],
        });
      }
    }
    await this.db.batch(statements as never, "IMMEDIATE");
  }

  /**
   * `put` for a file too big to hold twice: its parts are inserted a few at a
   * time under a key of their own, and the blob row is pointed at them in one
   * small transaction, so a reader never sees half a file. Moving the parts
   * onto `key` instead rewrote the whole file in one transaction, and the
   * database kept about 180 MB of it afterwards.
   */
  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const partsKey = `${key}${PARTS_SUFFIX}${Date.now()}`;
    await this.deleteParts(partsKey);
    const file = Bun.file(path);
    for (let at = 0, n = 0; at < file.size;) {
      const statements: { sql: string; args: unknown[] }[] = [];
      for (let i = 0; i < PARTS_PER_FILE_BATCH && at < file.size; i++, n++) {
        const bytes = await file.slice(at, at + BLOB_PART_BYTES).bytes();
        statements.push({
          sql: "INSERT INTO blob_part (key, n, bytes) VALUES (?, ?, ?)",
          args: [partsKey, n, bytes],
        });
        at += BLOB_PART_BYTES;
      }
      await this.db.batch(statements as never, "IMMEDIATE");
      Bun.gc(true);
    }
    const previous = await this.partsKeyOf(key);
    await this.db.batch(
      [
        {
          sql: `INSERT INTO blob (key, content_type, bytes, parts_key, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  content_type = excluded.content_type,
                  bytes        = excluded.bytes,
                  parts_key    = excluded.parts_key,
                  updated_at   = excluded.updated_at`,
          args: [key, contentType, new Uint8Array(0), partsKey, Date.now()],
        },
      ] as never,
      "IMMEDIATE",
    );
    await this.deleteParts(key);
    if (previous && previous !== key) await this.deleteParts(previous);
  }

  private async partsKeyOf(key: string): Promise<string | null> {
    const statement = await this.db.prepare("SELECT parts_key FROM blob WHERE key = ?");
    const row = (await statement.get([key])) as { parts_key: string | null } | undefined;
    return row?.parts_key ?? null;
  }

  /** A few parts a transaction, for the reason `putFile` writes them that way. */
  private async deleteParts(partsKey: string): Promise<void> {
    const count = await this.db.prepare("SELECT MAX(n) AS n FROM blob_part WHERE key = ?");
    const last = ((await count.get([partsKey])) as { n: number | null } | undefined)?.n ?? null;
    if (last === null) return;
    for (let from = 0; from <= last; from += PARTS_PER_FILE_BATCH) {
      await this.db.batch(
        [
          {
            sql: "DELETE FROM blob_part WHERE key = ? AND n >= ? AND n < ?",
            args: [partsKey, from, from + PARTS_PER_FILE_BATCH],
          },
        ] as never,
        "IMMEDIATE",
      );
    }
  }

  async isEmpty(): Promise<boolean> {
    const statement = await this.db.prepare("SELECT COUNT(*) AS n FROM blob");
    const row = (await statement.get()) as { n: number } | undefined;
    return (row?.n ?? 0) === 0;
  }
}

/** `files` names the file a key is kept in where that is not the key itself. */
export class DiskBlobs implements Blobs {
  constructor(
    private readonly root: string,
    private readonly files: Readonly<Record<string, string>> = {},
  ) {}

  private resolve(key: string): string {
    const path = normalize(join(this.root, this.files[key] ?? key));
    const root = normalize(this.root);
    if (!path.startsWith(root)) throw new Error(`Refusing to escape ${root}`);
    return path;
  }

  async getText(key: string): Promise<string | null> {
    try {
      return await readFile(this.resolve(key), "utf8");
    } catch {
      return null;
    }
  }

  async getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const buffer = await readFile(this.resolve(key));
      return new Uint8Array(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      ) as Uint8Array<ArrayBuffer>;
    } catch {
      return null;
    }
  }

  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    _contentType: string,
  ): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
}

function toBytes(value: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(value) as Uint8Array<ArrayBuffer>;
}
