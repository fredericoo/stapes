import type { Database } from "./db";

/**
 * Durable Object storage, reimplemented over Turso.
 *
 * **This deliberately keeps the shape it is replacing.** `GameServer` reads and
 * writes through `this.ctx.storage`, and those several hundred lines are the
 * most heavily tested code in the repository — the two bugs that ever shipped
 * in that file both lived in the load and restore paths. Presenting the same
 * interface means the runtime moves underneath the world without the world's
 * persistence logic changing, so the suite that guards it keeps being about the
 * same thing. Normalising into per-actor and per-chunk tables is worth doing
 * and is a later change, made with that suite green on both sides.
 *
 * Two differences from the platform original, both improvements:
 *
 * - **Writes are buffered and committed together.** The Durable Object's
 *   `put` returned a promise that `GameServer` deliberately did not await, so a
 *   tick could write without becoming asynchronous. Here `put` records into an
 *   in-memory map synchronously and {@link flush} commits the batch. The tick
 *   stays synchronous, and the batch is a transaction.
 * - **That transaction is what makes a death atomic.** `pendingDeathWrites`
 *   exists in `GameServer` because the board write and the actor write could
 *   land separately — how a sword carried into a losing fight ended up in
 *   neither the kit nor the cell. Both now ride one commit or neither does.
 */
export class WorldStore {
  /** Values written since the last flush, by key. */
  private readonly pending = new Map<string, unknown>();
  /** Keys deleted since the last flush. Disjoint from {@link pending}. */
  private readonly tombstones = new Set<string>();
  /** Statements queued by {@link sql}, committed with the batch. */
  private pendingSql: { query: string; bindings: unknown[] }[] = [];
  /** Set by {@link setAlarm}, cleared by {@link deleteAlarm}. */
  private alarmAtMs: number | null = null;
  private alarmDirty = false;
  /** Guards against two flushes overlapping, which would interleave batches. */
  private flushing: Promise<void> | null = null;

  /**
   * Told whenever the alarm moves, so a timer can be re-armed.
   *
   * A callback rather than the scheduler polling, because the gap matters: a
   * respawn deadline set now and noticed at the next flush is a deadline up to
   * a checkpoint interval late, every time. The Durable Object had a platform
   * to hand `setAlarm` to; this is the local equivalent.
   */
  onAlarmChange: ((atMs: number | null) => void) | null = null;

  constructor(private readonly db: Database) {}

  /**
   * The chat log's escape hatch, kept because `GameServer.logChat` writes SQL
   * directly and there is no reason for it not to.
   *
   * `exec` is synchronous and returns nothing, matching the platform API's
   * shape at the only call site that uses it — which ignores the result. The
   * statements are queued and committed with the next batch.
   */
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

  /**
   * Every key under a prefix, buffered writes included.
   *
   * The merge is not an optimisation — it is correctness. `pruneOldest` lists a
   * prefix and deletes the oldest rows it finds, and a listing that missed the
   * actors written thirty seconds ago would prune against a stale view.
   */
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

  /**
   * Record one value, or a batch of them.
   *
   * Returns an already-resolved promise so the callers that attach a `.catch`
   * for write failures keep working. A rejection can no longer originate here —
   * it originates in {@link flush}, which reports for itself.
   */
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

  /**
   * Forget the entire world.
   *
   * Committed immediately rather than buffered: the one caller is
   * `GameServer.resetWorld`, which is destructive by intent and awaits it. A
   * buffered `deleteAll` would also have to reconcile against every pending
   * write in the batch, which is complexity in aid of nothing.
   */
  async deleteAll(): Promise<void> {
    await this.settle();
    this.pending.clear();
    this.tombstones.clear();
    this.alarmAtMs = null;
    this.alarmDirty = false;

    // Queued statements run rather than being dropped with the buffered
    // writes, and the distinction is the point: a buffered `put` describes the
    // world being thrown away, while a statement someone wrote by hand is a
    // deliberate act aimed at the database. `resetWorld` queues
    // `DROP TABLE IF EXISTS chat` immediately before calling this, and
    // discarding it left the log of a world that no longer exists standing.
    const statements = this.pendingSql;
    this.pendingSql = [];

    await this.db.batch(
      [
        ...statements.map((statement) => ({
          sql: statement.query,
          args: statement.bindings,
        })),
        // The key-value side only. A table made through `sql` is not a key and
        // survives this — which is the behaviour being replaced, and what
        // `resetWorld`'s explicit drop above exists for.
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

  /** When the alarm is due, or null. Read by the scheduler in `server/world.ts`. */
  alarmAt(): number | null {
    return this.alarmAtMs;
  }

  /** Restore the alarm across a restart, before the world starts ticking. */
  async loadAlarm(): Promise<number | null> {
    const statement = await this.db.prepare("SELECT at_ms FROM alarm WHERE id = 0");
    const row = (await statement.get()) as { at_ms: number } | undefined;
    this.alarmAtMs = row?.at_ms ?? null;
    return this.alarmAtMs;
  }

  /** Whether anything is waiting to be written. */
  get dirty(): boolean {
    return (
      this.pending.size > 0 ||
      this.tombstones.size > 0 ||
      this.pendingSql.length > 0 ||
      this.alarmDirty
    );
  }

  /**
   * Commit everything buffered, as one transaction.
   *
   * The batch is taken *before* the first await, so writes made while the
   * commit is in flight belong to the next one rather than being lost or
   * half-applied. Overlapping calls are serialised through {@link flushing} for
   * the same reason: two transactions writing interleaved views of the same
   * board is precisely the corruption this exists to prevent.
   */
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

    // Many rows to a statement rather than one. The driver prepares every
    // statement in a batch afresh, and a checkpoint of a thousand players is a
    // few hundred chunks every couple of seconds and every actor now and then.
    // @see UPSERT_ROWS
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

    // `batch` with a mode rather than hand-written BEGIN/COMMIT, and the
    // difference is not cosmetic: a bare BEGIN does not own the connection, so
    // anything else writing at the same moment lands *inside* this window and
    // is rolled back with it if the checkpoint fails. The other writer here is
    // an editor save, and losing one silently because a chunk write failed is
    // exactly the class of bug this whole store exists to close.
    if (batch.length > 0) await this.db.batch(batch, "IMMEDIATE");
  }

  /** Wait for any in-flight commit, without starting a new one. */
  private async settle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }
}

/**
 * The key immediately after every key with this prefix.
 *
 * Turns a prefix scan into a range scan, so the primary key index does the work
 * rather than every row being read and filtered. Incrementing the last code
 * unit is exact for the keys in use here, which are ASCII.
 */
function prefixEnd(prefix: string): string {
  if (prefix === "") return "￿";
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/**
 * How many rows one upsert in a checkpoint writes.
 *
 * The checkpoint holds the event loop for as long as its batch runs — the
 * driver's steps do not yield — so its length is a hitch in the tick that
 * happens to follow it. At a thousand walking players a checkpoint was a few
 * hundred chunk rows every two seconds and took 70–90ms, and every actor's rows
 * as well now and then, 140–210ms. A hundred rows a statement is 200 bound
 * values, far inside any limit on them, and almost all of what grouping saves.
 */
const UPSERT_ROWS = 100;

const upsertSqlByRows = new Map<number, string>();

/** An upsert of `rows` key/value rows, built once for each count. */
function upsertSql(rows: number): string {
  let sql = upsertSqlByRows.get(rows);
  if (sql === undefined) {
    const values = Array.from({ length: rows }, () => "(?, ?)").join(", ");
    sql = `INSERT INTO kv (key, value) VALUES ${values} ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    upsertSqlByRows.set(rows, sql);
  }
  return sql;
}

/**
 * A value as the text of its JSON.
 *
 * **Text, although the column is declared `BLOB`.** The driver binds a string
 * several times faster than the same JSON as bytes — 300 chunk-sized rows took
 * 13–17ms as text and 47–64ms as a `Uint8Array` — and SQLite keeps whichever it
 * is given, since a `BLOB` column converts nothing. Rows written as bytes
 * before this are still read: {@link decode} takes either. @see `./db`
 */
function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decode(value: Uint8Array | string): unknown {
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  return JSON.parse(text);
}
