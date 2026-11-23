import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { Blobs } from "../app/lib/dataStore";
import type { Database } from "./db";

const BLOB_PART_BYTES = 1 << 20;

const PARTS_PER_FILE_BATCH = 8;

const WRITING_SUFFIX = "~writing";

export class SqliteBlobs implements Blobs {
  constructor(private readonly db: Database) {}

  async getText(key: string): Promise<string | null> {
    const bytes = await this.getBytes(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const statement = await this.db.prepare("SELECT bytes FROM blob WHERE key = ?");
    const row = (await statement.get([key])) as { bytes: Uint8Array | string } | undefined;
    if (!row) return null;
    const parts = await this.db.prepare("SELECT bytes FROM blob_part WHERE key = ? ORDER BY n");
    const rows = (await parts.all([key])) as { bytes: Uint8Array }[];
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
    const statements: { sql: string; args: unknown[] }[] = [
      { sql: "DELETE FROM blob_part WHERE key = ?", args: [key] },
      {
        sql: `INSERT INTO blob (key, content_type, bytes, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                content_type = excluded.content_type,
                bytes        = excluded.bytes,
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
   * `put` for a file too big to hold twice: its parts are read and inserted a
   * few at a time under a key nobody reads, then moved onto `key` in one
   * transaction, so a reader never sees half a file.
   */
  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const writing = `${key}${WRITING_SUFFIX}`;
    await this.db.batch(
      [{ sql: "DELETE FROM blob_part WHERE key = ?", args: [writing] }] as never,
      "IMMEDIATE",
    );
    const file = Bun.file(path);
    for (let at = 0, n = 0; at < file.size;) {
      const statements: { sql: string; args: unknown[] }[] = [];
      for (let i = 0; i < PARTS_PER_FILE_BATCH && at < file.size; i++, n++) {
        const bytes = await file.slice(at, at + BLOB_PART_BYTES).bytes();
        statements.push({
          sql: "INSERT INTO blob_part (key, n, bytes) VALUES (?, ?, ?)",
          args: [writing, n, bytes],
        });
        at += BLOB_PART_BYTES;
      }
      await this.db.batch(statements as never, "IMMEDIATE");
      Bun.gc(true);
    }
    await this.db.batch(
      [
        { sql: "DELETE FROM blob_part WHERE key = ?", args: [key] },
        { sql: "UPDATE blob_part SET key = ? WHERE key = ?", args: [key, writing] },
        {
          sql: `INSERT INTO blob (key, content_type, bytes, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  content_type = excluded.content_type,
                  bytes        = excluded.bytes,
                  updated_at   = excluded.updated_at`,
          args: [key, contentType, new Uint8Array(0), Date.now()],
        },
      ] as never,
      "IMMEDIATE",
    );
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
