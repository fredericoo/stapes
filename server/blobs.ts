import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { Blobs } from "../app/lib/dataStore";
import type { Database } from "./db";

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
    return toBytes(row.bytes);
  }

  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const statement = await this.db.prepare(
      `INSERT INTO blob (key, content_type, bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         content_type = excluded.content_type,
         bytes        = excluded.bytes,
         updated_at   = excluded.updated_at`,
    );
    await statement.run([key, contentType, bytes, Date.now()]);
  }

  async isEmpty(): Promise<boolean> {
    const statement = await this.db.prepare("SELECT COUNT(*) AS n FROM blob");
    const row = (await statement.get()) as { n: number } | undefined;
    return (row?.n ?? 0) === 0;
  }
}

export class DiskBlobs implements Blobs {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
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
