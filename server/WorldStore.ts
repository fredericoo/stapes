import type { Database } from "./db";

export class WorldStore {
  private readonly pending = new Map<string, unknown>();
  private readonly tombstones = new Set<string>();
  private pendingSql: { query: string; bindings: unknown[] }[] = [];
  private alarmAtMs: number | null = null;
  private alarmDirty = false;
  private flushing: Promise<void> | null = null;

  onAlarmChange: ((atMs: number | null) => void) | null = null;

  constructor(private readonly db: Database) {}

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]): void => {
      this.pendingSql.push({ query, bindings });
    },
  };

  async get<T>(key: string): Promise<T | undefined> {
    if (this.tombstones.has(key)) return undefined;
    if (this.pending.has(key)) return this.pending.get(key) as T;

    const statement = await this.db.prepare("SELECT value FROM kv WHERE key = ?");
    const row = (await statement.get([key])) as { value: Uint8Array | string } | undefined;
    return row ? (decode(row.value) as T) : undefined;
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const statement = await this.db.prepare(
      "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key",
    );
    const rows = (await statement.all([options.prefix, prefixEnd(options.prefix)])) as {
      key: string;
      value: Uint8Array | string;
    }[];

    const out = new Map<string, T>();
    for (const row of rows) {
      if (this.tombstones.has(row.key)) continue;
      out.set(row.key, decode(row.value) as T);
    }
    for (const [key, value] of this.pending) {
      if (key.startsWith(options.prefix)) out.set(key, value as T);
    }
    return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  put(key: string, value: unknown, options?: unknown): Promise<void>;
  put(entries: Record<string, unknown>, options?: unknown): Promise<void>;
  put(
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    _options?: unknown,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.write(keyOrEntries, valueOrOptions);
    } else {
      for (const [key, value] of Object.entries(keyOrEntries)) {
        this.write(key, value);
      }
    }
    return Promise.resolve();
  }

  private write(key: string, value: unknown) {
    this.tombstones.delete(key);
    this.pending.set(key, value);
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
    for (const key of keys) {
      this.pending.delete(key);
      this.tombstones.add(key);
    }
    return Promise.resolve(typeof keyOrKeys === "string" ? true : keys.length);
  }

  async deleteAll(): Promise<void> {
    await this.settle();
    this.pending.clear();
    this.tombstones.clear();
    this.alarmAtMs = null;
    this.alarmDirty = false;

    const statements = this.pendingSql;
    this.pendingSql = [];

    await this.db.batch(
      [
        ...statements.map((statement) => ({
          sql: statement.query,
          args: statement.bindings,
        })),
        { sql: "DELETE FROM kv", args: [] },
        { sql: "DELETE FROM alarm", args: [] },
      ],
      "IMMEDIATE",
    );
  }

  setAlarm(atMs: number): Promise<void> {
    this.alarmAtMs = atMs;
    this.alarmDirty = true;
    this.onAlarmChange?.(atMs);
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAtMs = null;
    this.alarmDirty = true;
    this.onAlarmChange?.(null);
    return Promise.resolve();
  }

  alarmAt(): number | null {
    return this.alarmAtMs;
  }

  async loadAlarm(): Promise<number | null> {
    const statement = await this.db.prepare("SELECT at_ms FROM alarm WHERE id = 0");
    const row = (await statement.get()) as { at_ms: number } | undefined;
    this.alarmAtMs = row?.at_ms ?? null;
    return this.alarmAtMs;
  }

  get dirty(): boolean {
    return (
      this.pending.size > 0 ||
      this.tombstones.size > 0 ||
      this.pendingSql.length > 0 ||
      this.alarmDirty
    );
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;

    const entries = [...this.pending];
    const deletions = [...this.tombstones];
    const statements = this.pendingSql;
    const alarm = this.alarmDirty ? this.alarmAtMs : undefined;
    this.pending.clear();
    this.tombstones.clear();
    this.pendingSql = [];
    this.alarmDirty = false;

    this.flushing = this.commit(entries, deletions, statements, alarm).finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  private async commit(
    entries: [string, unknown][],
    deletions: string[],
    statements: { query: string; bindings: unknown[] }[],
    alarm: number | null | undefined,
  ): Promise<void> {
    const batch: { sql: string; args: unknown[] }[] = [];

    for (let at = 0; at < entries.length; at += UPSERT_ROWS) {
      const rows = Math.min(UPSERT_ROWS, entries.length - at);
      const args: unknown[] = [];
      for (let i = at; i < at + rows; i++) {
        const [key, value] = entries[i]!;
        args.push(key, encode(value));
      }
      batch.push({ sql: upsertSql(rows), args });
    }
    for (const key of deletions) {
      batch.push({ sql: "DELETE FROM kv WHERE key = ?", args: [key] });
    }
    for (const statement of statements) {
      batch.push({ sql: statement.query, args: statement.bindings });
    }
    if (alarm === null) {
      batch.push({ sql: "DELETE FROM alarm", args: [] });
    } else if (alarm !== undefined) {
      batch.push({
        sql: "INSERT INTO alarm (id, at_ms) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET at_ms = excluded.at_ms",
        args: [alarm],
      });
    }

    if (batch.length > 0) await this.db.batch(batch, "IMMEDIATE");
  }

  private async settle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }
}

function prefixEnd(prefix: string): string {
  if (prefix === "") return "￿";
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

const UPSERT_ROWS = 100;

const upsertSqlByRows = new Map<number, string>();

function upsertSql(rows: number): string {
  let sql = upsertSqlByRows.get(rows);
  if (sql === undefined) {
    const values = Array.from({ length: rows }, () => "(?, ?)").join(", ");
    sql = `INSERT INTO kv (key, value) VALUES ${values} ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    upsertSqlByRows.set(rows, sql);
  }
  return sql;
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decode(value: Uint8Array | string): unknown {
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  return JSON.parse(text);
}
