import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { Blobs } from "../app/lib/storage.server";
import type { Database } from "./db";

/**
 * Authored content in the database.
 *
 * Replaces `R2Blobs`. A table rather than a bucket because the whole of it is
 * around two and a half megabytes — a bucket would be a second service to
 * provision, back up and clone for every preview environment, in aid of data
 * that fits comfortably in the file we already keep.
 *
 * Reads go straight to the database rather than through `WorldStore`'s write
 * buffer: authored content is written by an editor save, at human speed, and
 * has none of the per-tick batching that buffer exists for.
 */
export class SqliteBlobs implements Blobs {
  constructor(private readonly db: Database) {}

  async getText(key: string): Promise<string | null> {
    const bytes = await this.getBytes(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const statement = await this.db.prepare(
      "SELECT bytes FROM blob WHERE key = ?",
    );
    const row = (await statement.get([key])) as
      | { bytes: Uint8Array | string }
      | undefined;
    if (!row) return null;
    return toBytes(row.bytes);
  }

  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<void> {
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    const statement = await this.db.prepare(
      `INSERT INTO blob (key, content_type, bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         content_type = excluded.content_type,
         bytes        = excluded.bytes,
         updated_at   = excluded.updated_at`,
    );
    await statement.run([key, contentType, bytes, Date.now()]);
  }

  /** Whether anything has been authored yet. Drives the seed-on-boot path. */
  async isEmpty(): Promise<boolean> {
    const statement = await this.db.prepare("SELECT COUNT(*) AS n FROM blob");
    const row = (await statement.get()) as { n: number } | undefined;
    return (row?.n ?? 0) === 0;
  }
}

/**
 * Authored content on disk, for development.
 *
 * The point is unchanged from the Worker version: `data/` stays the single
 * source of truth while developing, so a tileset edited in an external tool is
 * live on the next request and the map editor's Save lands in `data/map.json`
 * as a reviewable diff. What has gone is the plumbing — the Worker had no
 * filesystem, so this used to be an HTTP call to a Vite middleware that in turn
 * read the directory, with the origin threaded through the socket handshake so
 * a Durable Object could find it. There is a filesystem now, so it is a file
 * read.
 */
export class DiskBlobs implements Blobs {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    // `normalize` then a prefix check, because the tileset routes take a
    // filename from the request. `DataStore` already guards the name, and this
    // is the second lock on the same door.
    const path = normalize(join(this.root, key));
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
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ),
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
  // Copied into a plain ArrayBuffer rather than handed on as-is: only the
  // concrete form is a valid Response body, and tileset PNGs go into one.
  return new Uint8Array(value) as Uint8Array<ArrayBuffer>;
}
